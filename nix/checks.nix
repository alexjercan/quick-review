{
  lib,
  nodejs,
  pkgs,
  quickReview,
  source,
}: let
  packageRoot = "${quickReview}/share/quick-review";
  workspace = ''
    cp -R ${source} source
    chmod -R u+w source
    export HOME="$PWD/home"
    mkdir -p "$HOME"
    cd source
  '';
  # Tests that load the Pi entry point need the npm dependency tree, which this
  # offline check cannot provide. The set is declared here and verified against
  # the tree, so a new Pi-dependent test can never be skipped silently.
  piTests = ["tests/extension.test.ts"];
in {
  tests =
    pkgs.runCommand "quick-review-tests" {
      nativeBuildInputs = [nodejs pkgs.git];
    } ''
      ${workspace}
      declared=${lib.escapeShellArg (lib.concatStringsSep "\n" piTests)}
      detected=$(grep -l "quick-review/index.ts" tests/*.test.ts | sort)
      if [ "$declared" != "$detected" ]; then
        echo "Pi-dependent test set changed." >&2
        echo "declared: $declared" >&2
        echo "detected: $detected" >&2
        exit 1
      fi
      offline=$(printf '%s\n' tests/*.test.ts | grep -vxF "$declared")
      echo "skipped offline (needs node_modules, covered by npm run check):"
      echo "$declared" | sed 's/^/  /'
      echo "running:"
      echo "$offline" | sed 's/^/  /'
      # shellcheck disable=SC2086
      node --test --test-concurrency=1 $offline
      touch "$out"
    '';

  format =
    pkgs.runCommand "quick-review-format" {
      nativeBuildInputs = [pkgs.prettier];
    } ''
      ${workspace}
      prettier --check .
      touch "$out"
    '';

  nix-format =
    pkgs.runCommand "quick-review-nix-format" {
      nativeBuildInputs = [pkgs.alejandra];
    } ''
      mkdir -p sources/nix
      cp ${../flake.nix} sources/flake.nix
      cp ${../nix/checks.nix} sources/nix/checks.nix
      chmod -R u+w sources
      alejandra --check sources
      touch "$out"
    '';

  package =
    pkgs.runCommand "quick-review-package" {
      nativeBuildInputs = [nodejs pkgs.jq];
    } ''
      root=${lib.escapeShellArg packageRoot}
      test -f "$root/package.json"
      test -f "$root/LICENSE"
      test -d "$root/docs"
      jq -e '.keywords | index("pi-package")' "$root/package.json" > /dev/null
      jq -e '.peerDependencies["@earendil-works/pi-coding-agent"]' "$root/package.json" > /dev/null
      entry=$(jq -r '.pi.extensions[0]' "$root/package.json")
      test -f "$root/$entry"
      test ! -e "$root/node_modules"
      test ! -e "$root/tests"
      # The Claude Code plugin ships with a command and a server that exists.
      # Only a plugin-root `.mcp.json` is read; a `mcpServers` field in
      # plugin.json is ignored, whether it holds an object or a path.
      test -f "$root/.claude-plugin/plugin.json"
      test -f "$root/.claude-plugin/marketplace.json"
      test -f "$root/commands/quick-review.md"
      ! jq -e '.mcpServers' "$root/.claude-plugin/plugin.json" > /dev/null
      server=$(jq -r '.review.args[0]' "$root/.mcp.json" | sed 's|^[^/]*/||')
      test -f "$root/$server"
      # The extension must not reach back into any other project at runtime.
      ! grep -rn "scufris\|sprout" "$root/extensions"
      # Only the Pi entry point may import Pi APIs.
      offenders=$(grep -rl '@earendil-works\|"typebox"' "$root/extensions" \
        | grep -v '/index\.ts$' || true)
      test -z "$offenders"
      # Every non-Pi module loads on plain Node, the MCP entry point included:
      # it has to run with no dependency tree at all.
      node --input-type=module -e "
        await import('$root/extensions/quick-review/review.ts');
        await import('$root/extensions/quick-review/page.ts');
        await import('$root/extensions/quick-review/options.ts');
        await import('$root/extensions/quick-review/prompt.ts');
        await import('$root/extensions/quick-review/host.ts');
        await import('$root/extensions/quick-review/jsonrpc.ts');
        await import('$root/extensions/quick-review/mcp.ts');
      "
      touch "$out"
    '';

  end-to-end =
    pkgs.runCommand "quick-review-end-to-end" {
      nativeBuildInputs = [nodejs pkgs.git];
      QUICK_REVIEW_PACKAGE = packageRoot;
      QUICK_REVIEW_NO_OPEN = "1";
    } ''
      export HOME="$PWD/home"
      mkdir -p "$HOME"
      node ${../nix/e2e.mjs}
    '';
}
