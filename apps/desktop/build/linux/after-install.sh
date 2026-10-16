#!/bin/sh
# Styx .deb post-install: the polkit action that guards production grants (see build/linux/polkit).
set -e
install -D -m 0644 "/opt/Styx/resources/polkit/com.styx.app.policy" \
  /usr/share/polkit-1/actions/com.styx.app.policy
