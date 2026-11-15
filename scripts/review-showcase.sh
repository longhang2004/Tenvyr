#!/bin/sh
set -e
exec node "$(dirname "$0")/review-showcase.mjs" "$@"
