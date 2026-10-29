FROM eclipse-temurin:21-jre

ARG GRAPHHOPPER_VERSION=11.0

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/graphhopper

RUN curl -fL \
      "https://github.com/graphhopper/graphhopper/releases/download/${GRAPHHOPPER_VERSION}/graphhopper-web-${GRAPHHOPPER_VERSION}.jar" \
      -o /opt/graphhopper/graphhopper-web.jar

COPY config.yml /opt/graphhopper/config.yml
COPY custom-models /opt/graphhopper/custom-models
COPY start.sh /opt/graphhopper/start.sh

RUN chmod +x /opt/graphhopper/start.sh

EXPOSE 8989

ENTRYPOINT ["/opt/graphhopper/start.sh"]
