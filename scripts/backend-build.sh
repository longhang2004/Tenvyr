#!/bin/sh
set -eu
TENVYR_SCRIPT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$TENVYR_SCRIPT_ROOT"
if [ "${TENVYR_MAVEN_OFFLINE:-false}" = true ]; then
  mvn -o -B -f backend/pom.xml package -DskipTests org.apache.maven.plugins:maven-dependency-plugin:3.9.0:copy-dependencies -DincludeScope=runtime "$@"
else
  mvn -B -f backend/pom.xml package -DskipTests org.apache.maven.plugins:maven-dependency-plugin:3.9.0:copy-dependencies -DincludeScope=runtime "$@"
fi
