# glibc base is mandatory: @remotion/compositor-linux-x64-gnu is a native gnu
# binary and will not load on musl/Alpine.
FROM node:24-bookworm-slim

# ffmpeg brings ffprobe too (src/pipeline.ts probes durations, src/sync.ts
# extracts audio). The lib* set is what chrome-headless-shell needs to start —
# Remotion downloads the shell itself into node_modules/.remotion on first render.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates curl git tmux dtach procps \
      melt frei0r-plugins \
      libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libasound2 \
      libxrandr2 libxkbcommon0 libxfixes3 libxcomposite1 libxdamage1 \
      libxext6 libxi6 libgbm1 libpango-1.0-0 libcairo2 libcups2 \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Standalone binary rather than the distro package: Twitch breaks yt-dlp often
# and this lets `yt-dlp -U` fix it without rebuilding the image.
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
      -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

# Only the claude-youtube skill needs these, and only for `npm run analytics`. ~140 MB, which is
# most of what python adds here — drop this layer if you never run analytics on the lab.
# --break-system-packages because bookworm marks the system python externally-managed (PEP 668);
# a venv would be the answer on a real host, but this is a single-purpose container.
RUN pip3 install --no-cache-dir --break-system-packages \
      google-api-python-client google-auth-oauthlib

RUN npm install -g @anthropic-ai/claude-code

# Installed as root but run as node, so `claude doctor` reports it cannot
# auto-update ("npm global folder isn't writable"). Handing the global tree to
# node lets it self-update for the container's lifetime; a rebuild reinstalls
# latest anyway, so this is self-correcting rather than drift.
RUN chown -R node:node /usr/local/lib/node_modules /usr/local/bin

# Must exist, owned by node, BEFORE the named volume mounts over it: Docker
# creates a missing mountpoint as root:root, which would leave Claude unable to
# write its own login. Pre-creating it makes the volume inherit node:node.
RUN mkdir -p /home/node/.claude && chown -R node:node /home/node/.claude

# /home/node is a container layer, so this would be lost on recreate if it were
# only written at runtime. tmux's 500ms default escape-time mangles Claude Code's
# TUI input and redraws; RGB stops tmux downsampling its 24-bit palette.
RUN printf '%s\n' \
      'set -sg escape-time 0' \
      'set -g default-terminal "tmux-256color"' \
      'set -ga terminal-features ",*:RGB"' \
      'setw -g aggressive-resize on' \
      'set -g mouse on' \
      'set -g history-limit 50000' \
      'set -g renumber-windows on' \
      > /home/node/.tmux.conf && chown node:node /home/node/.tmux.conf

# Passwordless sudo for `node`. This makes the user effectively root *inside the
# container*, which is the point: an unattended agent has to be able to install a
# package without a human at the keyboard. Isolation from the host then rests on
# Docker alone, not on the user account — acceptable for a disposable container on
# a home LAN, and not something to copy onto a shared host.
#
# The VA driver is what lets the final export use the lab's Intel HD 520 instead of
# grinding H.264 on two cores. It belongs in the container, not on the host: the
# host only needs the i915 kernel driver, which it already has. Both drivers are
# installed because Skylake (Gen9) sits on the boundary — iHD covers Gen8+, i965 is
# the legacy path — and libva picks by PCI id. Override with LIBVA_DRIVER_NAME if it
# chooses wrong. Needs /dev/dri passed in and group_add for the render gid: see
# compose.yaml.
# xvfb and xauth are not optional for headless melt, despite melt itself being a
# CLI tool. MLT's Qt module backs both `qimage` (the PNG overlay bands) and
# `qtblend` (the split-screen positioning), and it hard-fails without an X
# display: "The MLT Qt module requires a X11 environment." Every render must
# therefore go through `xvfb-run -a melt`. xauth is a separate package and
# xvfb-run exits 3 without it ("xauth command not found").
#
# Note this is unrelated to the melt 7.12 vs project 7.40 version gap, which was
# measured and is a non-issue: every service a Kdenlive save uses here
# (audiolevel, avformat-novalidate, color, mix, panner, qimage, qtblend, volume)
# exists in 7.12.
# rsync is not optional: src/archive.ts and `npm run archive` both shell out to it to copy a
# published match to the NAS, and it is preferred over cp precisely because the CIFS mount can
# I/O-error mid-write. Without it, archiving fails with ENOENT after every upload.
#
# python3 is needed by `npm run analytics` (which shells into the claude-youtube skill),
# branding/generate_brand_assets.py, and src/hooks.test.ts, which uses it to stand up a fake
# HOOK_SUGGEST_CMD. The repo's own YouTube code is plain fetch and needs none of this.
RUN apt-get update && apt-get install -y --no-install-recommends \
      sudo xvfb xauth rsync python3 python3-pip \
      intel-media-va-driver i965-va-driver libva2 libva-drm2 vainfo \
    && echo 'node ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node \
    && rm -rf /var/lib/apt/lists/*

# Claude Code refuses --dangerously-skip-permissions when running as root, so the
# autonomy decision depends on this line. node:24 ships a `node` user at uid 1000,
# which matches the host's `homelab` user (uid=1000, gid=1000) exactly, so
# bind-mounted files get correct ownership on both sides.
USER node
WORKDIR /app

# node_modules is deliberately NOT baked in: /app is a bind mount, so anything
# built here would be shadowed at runtime. Run `npm install` once in the container.
CMD ["sleep", "infinity"]
