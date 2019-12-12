import { EthereumClient } from '../eth/client';
import { gethMemStats, gethMetrics, gethNodeInfo, gethTxpool, gethPeers } from '../eth/requests';
import { GethMemStats, GethMetrics, GethNodeInfo, GethPeer } from '../eth/responses';
import { OutputMessage } from '../output';
import { createModuleDebug } from '../utils/debug';
import { GenericNodeAdapter } from './generic';

const { debug, error } = createModuleDebug('platforms:geth');

type MetricsObj = { [k: string]: number | string | MetricsObj | any };

const ABBREVIATE_UNITS: { [k: string]: number } = {
    K: 1_000,
    M: 1_000_000,
    G: 1_000_000_000,
    T: 1_000_000_000_000,
};

export function parseAbbreviatedNumber(s: string): number {
    let rest = s;
    let factor = 1;
    const unitFactor = ABBREVIATE_UNITS[s[s.length - 1]];
    if (unitFactor != null) {
        rest = s.slice(0, -1);
        factor = unitFactor;
    }
    return parseFloat(rest) * factor;
}

/** Parses golang-formatted duration string */
export function durationStringToMs(dur: string): number {
    let millis = 0;
    let neg = false;
    const len = dur.length;
    let i = 0;
    if (dur[0] === '-') {
        neg = true;
        i++;
    } else if (dur[0] === '+') {
        i++;
    }
    while (i < len) {
        let j = i;
        do {
            const c = dur[j];
            if (!((c >= '0' && c <= '9') || c === '.')) {
                j++;
                break;
            }
        } while (++j < len);
        if (i === j) {
            // empty string
            return NaN;
        }
        const n = parseFloat(dur.slice(i, j - 1));
        if (isNaN(n)) {
            return NaN;
        }
        i = j - 1;
        const unitStr = dur.slice(i, i + 2);
        if (unitStr === 'ns') {
            millis += n / 1_000_000;
            i += 2;
        } else if (unitStr === 'us' || unitStr === 'µs' || unitStr === 'μs') {
            millis += n / 1_000;
            i += 2;
        } else if (unitStr === 'ms') {
            millis += n;
            i += 2;
        } else if (unitStr[0] === 's') {
            millis += n * 1_000;
            i += 1;
        } else if (unitStr[0] === 'm') {
            millis += n * 60_0000;
            i += 1;
        } else if (unitStr[0] === 'h') {
            millis += n * 360_000;
            i += 1;
        } else {
            // not a unit
            return NaN;
        }
    }
    return millis * (neg ? -1 : 1);
}

const uncapitalize = (s: string): string => s[0].toLowerCase() + s.slice(1);

type SingleMeasurement = [string, number | undefined];

function formatGenericMetrics(obj: MetricsObj, prefix: string): SingleMeasurement[] {
    return Object.entries(obj).flatMap(([name, value]) => {
        if (typeof value === 'number') {
            return [`${prefix}.${uncapitalize(name)}`, value];
        }
        if (typeof value === 'string') {
            // Check if value is in the form of "0 (0.00/s)" and parse the first value (and exclude the per-second rate)
            if (value.endsWith(')')) {
                const parts = value.split(' ');
                if (parts.length === 2) {
                    const n = parseAbbreviatedNumber(parts[0]);
                    if (n != null && !isNaN(n)) {
                        return [`${prefix}.${uncapitalize(name)}`, n];
                    }
                }
            }
            if (value.endsWith('s')) {
                const dur = durationStringToMs(value);
                if (!isNaN(dur)) {
                    return [`${prefix}.${uncapitalize(name)}`, dur];
                }
            }
        }
        if (Array.isArray(value)) {
            // ignore arrays for now as they only seem to contain timings that can't be easily
            // turned into metrics for now
            return [];
        }
        if (typeof obj === 'object') {
            return formatGenericMetrics(value, `${prefix}.${uncapitalize(name)}`);
        }
        return [];
    });
}

export function formatGethMetrics(metrics: GethMetrics): SingleMeasurement[] {
    return formatGenericMetrics(metrics, 'geth.metrics');
}

export function formatGethMemStats(memStats: GethMemStats): SingleMeasurement[] {
    const prefix = 'geth.memStats.';
    const { BySize: bySize, ...rest } = memStats;
    return Object.entries(rest)
        .filter(([, v]) => typeof v === 'number')
        .map(([name, value]) => [prefix + uncapitalize(name), value] as SingleMeasurement)
        .concat(
            bySize != null
                ? bySize.flatMap(s => [
                      [`${prefix}bySize.${s.Size}.mallocs`, s.Mallocs],
                      [`${prefix}bySize.${s.Size}.frees`, s.Frees],
                  ])
                : []
        );
}

export async function captureGethMetrics(ethClient: EthereumClient, captureTime: number): Promise<OutputMessage[]> {
    const [metricsResults, memStatsResults] = await Promise.all([
        ethClient.request(gethMetrics(true)),
        ethClient.request(gethMemStats()),
    ]);
    return [
        {
            type: 'node:metrics',
            time: captureTime,
            metrics: Object.fromEntries([...formatGethMetrics(metricsResults), ...formatGethMemStats(memStatsResults)]),
        },
    ];
}

export async function captureTxpoolData(ethClient: EthereumClient, captureTime: number): Promise<OutputMessage[]> {
    try {
        const txpool = await ethClient.request(gethTxpool());
        const pending = Object.values(txpool.pending).flatMap(o => Object.values(o));
        const queued = Object.values(txpool.queued).flatMap(o => Object.values(o));
        return [
            {
                type: 'node:metrics',
                time: captureTime,
                metrics: { 'geth.txpool.pending': pending.length, 'geth.txpool.queued': queued.length },
            },
            // TODO: send messages for raw pending/queued transactions
        ];
    } catch (e) {
        error('Failed to retrive txpool data from geth node', e);
        return [];
    }
}

export async function capturePeers(ethClient: EthereumClient, captureTime: number): Promise<OutputMessage[]> {
    const peers = await ethClient.request(gethPeers());
    return peers.map((peer: GethPeer) => ({
        type: 'geth:peer',
        time: captureTime,
        peer,
    }));
}

export class GethAdapter extends GenericNodeAdapter {
    public readonly fullVersion: string;
    protected nodeInfo?: GethNodeInfo;

    constructor(clientVersion: string) {
        super(clientVersion);
        this.fullVersion = clientVersion;
    }

    public async initialize(ethClient: EthereumClient) {
        debug('Retrieving nodeInfo from geth node');
        const [nodeInfo] = await Promise.all([ethClient.request(gethNodeInfo())]);
        debug('Retrieved node info: %O', nodeInfo);
        this.nodeInfo = nodeInfo;
    }

    public get name(): string {
        return 'geth';
    }

    public get enode(): string | null {
        return this.nodeInfo?.enode || null;
    }

    public async captureNodeStats(ethClient: EthereumClient, captureTime: number): Promise<OutputMessage[]> {
        const [genericStats, metrics, txpool] = await Promise.all([
            super.captureNodeStats(ethClient, captureTime),
            captureGethMetrics(ethClient, captureTime),
            captureTxpoolData(ethClient, captureTime),
            capturePeers(ethClient, captureTime),
        ]);
        return [...genericStats, ...metrics, ...txpool];
    }
}