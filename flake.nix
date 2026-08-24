{
  description = "Quick Review: a Pi extension that turns a git range into a reviewable walkthrough page";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs = inputs @ {flake-parts, ...}:
    flake-parts.lib.mkFlake {inherit inputs;} {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      perSystem = {pkgs, ...}: let
        inherit (pkgs) lib;
        manifest = builtins.fromJSON (builtins.readFile ./package.json);
        source = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./AGENTS.md
            ./LICENSE
            ./README.md
            ./commands
            ./docs
            ./extensions
            ./package.json
            ./tests
            ./tsconfig.json
            ./.claude-plugin
            ./.mcp.json
            ./.prettierignore
          ];
        };
        nodejs = pkgs.nodejs_24;
        quickReview = pkgs.runCommand "quick-review-${manifest.version}" {} ''
          root="$out/share/quick-review"
          mkdir -p "$root"
          cp -R ${./extensions} "$root/extensions"
          cp -R ${./commands} "$root/commands"
          cp -R ${./docs} "$root/docs"
          cp -R ${./.claude-plugin} "$root/.claude-plugin"
          cp ${./.mcp.json} "$root/.mcp.json"
          cp ${./package.json} "$root/package.json"
          cp ${./README.md} "$root/README.md"
          cp ${./LICENSE} "$root/LICENSE"
          chmod -R u+w "$root"
        '';
        devShell = pkgs.mkShell {
          packages = [
            nodejs
            pkgs.alejandra
            pkgs.git
            pkgs.prettier
          ];
        };
      in {
        formatter = pkgs.alejandra;

        packages = {
          default = quickReview;
          quick-review = quickReview;
        };

        checks = import ./nix/checks.nix {
          inherit lib nodejs pkgs quickReview source;
        };

        devShells.default = devShell;
      };
    };
}
