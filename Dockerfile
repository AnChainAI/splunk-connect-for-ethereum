FROM node:12-alpine as builder

WORKDIR /ethlogger

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . ./
RUN yarn build

# MAIN IMAGE
FROM node:12-alpine

WORKDIR /ethlogger

COPY --from=builder /ethlogger/package.json /ethlogger/yarn.lock /ethlogger/
COPY --from=builder /ethlogger/defaults.ethlogger.yaml /ethlogger/
RUN yarn install --production --frozen-lockfile && yarn link

COPY --from=builder /ethlogger/bin /ethlogger/bin
COPY --from=builder /ethlogger/lib /ethlogger/lib

WORKDIR /app
VOLUME /app

RUN addgroup -S ethlogger && adduser -H -h /app -S ethlogger -G ethlogger && chown -R ethlogger:ethlogger ./
USER ethlogger

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 CMD ethlogger --health-check

ENV NODE_ENV production

ENTRYPOINT [ "ethlogger" ]
