#!/usr/bin/env bash

set -eo pipefail

MIN_NODE_VERSION=24
NVM_VERSION=v0.40.8
REGISTRY="https://npm.cnb.cool/yonyeyy/flux-agent/-/packages/"
PACKAGE="@yonyeyy/flux-agent@latest"

node_is_supported() {
  local version
  version="$(node --version 2>/dev/null)" || return 1
  [[ "$version" =~ ^v([0-9]+)\. ]] && (( BASH_REMATCH[1] >= MIN_NODE_VERSION ))
}

main() {
  echo "Flux Agent Installer"

  if ! node_is_supported; then
    echo "Node.js ${MIN_NODE_VERSION}+ is required. Installing Node.js ${MIN_NODE_VERSION} with nvm..."

    if [ -z "${NVM_DIR:-}" ]; then
      if [ -n "${XDG_CONFIG_HOME:-}" ]; then
        export NVM_DIR="$XDG_CONFIG_HOME/nvm"
      else
        export NVM_DIR="$HOME/.nvm"
      fi
    fi
    export NVM_DIR

    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
      mkdir -p "$NVM_DIR"
      local installer
      installer="$(mktemp)"
      trap 'rm -f "$installer"' EXIT
      local installer_url="https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh"
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$installer_url" -o "$installer"
      elif command -v wget >/dev/null 2>&1; then
        wget -qO "$installer" "$installer_url"
      else
        echo "Install curl or wget, then run this installer again." >&2
        exit 1
      fi

      # Use nvm's script download mode so a fresh Mac does not need Git/Xcode first.
      METHOD=script bash "$installer"
      rm -f "$installer"
      trap - EXIT
    fi

    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
      echo "nvm installation failed: $NVM_DIR/nvm.sh was not created." >&2
      exit 1
    fi
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh" --no-use
    nvm install "$MIN_NODE_VERSION"
    nvm use "$MIN_NODE_VERSION"
  fi

  if ! node_is_supported; then
    echo "Node.js ${MIN_NODE_VERSION}+ is still unavailable. Check your Node.js installation and PATH." >&2
    exit 1
  fi
  if ! command -v npm >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1; then
    echo "npm or npx is missing. Reinstall Node.js with npm included, then try again." >&2
    exit 1
  fi

  local npm_version
  npm_version="$(npm --version)"
  echo "Node.js: $(node --version)"
  echo "npm: $npm_version"
  echo "Configuring the @yonyeyy registry in your user npm configuration..."
  npm config set "@yonyeyy:registry" "$REGISTRY" --location=user

  echo "Starting Flux Agent. Press Ctrl+C to stop."
  exec npx --yes "$PACKAGE" web "$@"
}

# Parse the entire entry point before starting a long-running process when piped to Bash.
main "$@"
