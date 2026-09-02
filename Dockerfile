# glibc base is mandatory: @remotion/compositor-linux-x64-gnu is a native gnu
# binary and will not load on musl/Alpine.
FROM node:24-bookworm-slim

# ffmpeg brings ffprobe too (src/pipeline.ts probes durations, src/sync.ts
# extracts audio). The lib* set is what chrome-headless-shell needs to start —
# Remotion downloads the shell itself into node_modules/.remotion on first render.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates curl git tmux dtach procps \
      libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libasound2 \
      libxrandr2 libxkbcommon0 libxfixes3 libxcomposite1 libxdamage1 \
      libxext6 libxi6 libgbm1 libpango-1.0-0 libcairo2 libcups2 \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Standalone binary rather than the distro package: Twitch breaks yt-dlp often
# and this lets `yt-dlp -U` fix it without rebuilding the image.
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
      -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

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

# Claude Code refuses --dangerously-skip-permissions when running as root, so the
# autonomy decision depends on this line. node:24 ships a `node` user at uid 1000,
# which matches the host's `homelab` user (uid=1000, gid=1000) exactly, so
# bind-mounted files get correct ownership on both sides.
USER node
WORKDIR /app

# node_modules is deliberately NOT baked in: /app is a bind mount, so anything
# built here would be shadowed at runtime. Run `npm install` once in the container.
CMD ["sleep", "infinity"]
