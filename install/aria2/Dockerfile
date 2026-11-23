FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends aria2 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY install/aria2/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
