FROM debian:trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends transmission-daemon ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY install/transmission/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
