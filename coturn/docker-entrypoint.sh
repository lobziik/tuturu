#!/bin/sh
set -e

# Substitute environment variables in the template config
envsubst < /etc/coturn/turnserver.conf.template > /etc/coturn/turnserver.conf

# Execute coturn with passed arguments
exec turnserver "$@"
