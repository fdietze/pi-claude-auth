{
  description = "Development shell for pi-claude-auth";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  # Only the toolchain that has to exist before `pnpm install` lives here.
  # Linters and the TypeScript compiler are pinned in package.json devDependencies,
  # so the versions used locally and in CI are the same.
  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.pnpm
            pkgs.just
          ];
        };
      });
    };
}
