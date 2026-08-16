/**
 * `appbay completion` — generate shell completion scripts.
 */
import { Command } from "commander";

const BASH_COMPLETION = `# Appbay bash completion
_appbay() {
  local cur commands
  cur="\${COMP_WORDS[COMP_CWORD]}"
  commands="init server doctor version list status ps logs validate compile eject apply up down restart pull delete rebuild-cache config env presets secrets open url home info size fixfs update completion"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
  fi
}
complete -F _appbay appbay`;

const ZSH_COMPLETION = `# Appbay zsh completion
_appbay() {
  local -a commands
  commands=(
    'init:Initialize Appbay home directory'
    'server:Manage the Appbay server'
    'doctor:Check prerequisites'
    'version:Print version'
    'list:List discovered apps'
    'status:Show app status'
    'ps:Container status'
    'logs:Show app logs'
    'validate:Validate configs'
    'compile:Compile app definitions'
    'eject:Export standalone compose'
    'apply:Apply deployment plan'
    'up:Deploy apps'
    'down:Stop apps'
    'restart:Restart apps'
    'pull:Pull latest images'
    'delete:Delete an app'
    'rebuild-cache:Regenerate SQLite cache'
    'config:App configuration'
    'env:Environment variables'
    'presets:App selection presets'
    'secrets:Secret URI references'
    'open:Open app in browser'
    'url:Print app URL'
    'home:Print APPBAY_HOME'
    'info:System information'
    'size:Disk usage'
    'fixfs:Fix permissions'
    'update:Update CLI and images'
    'completion:Shell completion'
  )
  _describe 'command' commands
}
compdef _appbay appbay`;

const FISH_COMPLETION = `# Appbay fish completion
complete -c appbay -f
complete -c appbay -n '__fish_use_subcommand' -a init -d 'Initialize Appbay'
complete -c appbay -n '__fish_use_subcommand' -a server -d 'Manage server'
complete -c appbay -n '__fish_use_subcommand' -a doctor -d 'Check prerequisites'
complete -c appbay -n '__fish_use_subcommand' -a list -d 'List apps'
complete -c appbay -n '__fish_use_subcommand' -a status -d 'App status'
complete -c appbay -n '__fish_use_subcommand' -a up -d 'Deploy apps'
complete -c appbay -n '__fish_use_subcommand' -a down -d 'Stop apps'
complete -c appbay -n '__fish_use_subcommand' -a restart -d 'Restart apps'
complete -c appbay -n '__fish_use_subcommand' -a logs -d 'Show logs'
complete -c appbay -n '__fish_use_subcommand' -a validate -d 'Validate configs'
complete -c appbay -n '__fish_use_subcommand' -a compile -d 'Compile apps'
complete -c appbay -n '__fish_use_subcommand' -a apply -d 'Apply plan'
complete -c appbay -n '__fish_use_subcommand' -a eject -d 'Export compose'
complete -c appbay -n '__fish_use_subcommand' -a secrets -d 'Secret references'
complete -c appbay -n '__fish_use_subcommand' -a config -d 'App config'
complete -c appbay -n '__fish_use_subcommand' -a env -d 'Environment vars'`;

export const completionCommand = new Command("completion")
  .description("Generate shell completion scripts")
  .argument("[shell]", "shell type: bash, zsh, fish", "bash")
  .action((shell: string) => {
    switch (shell) {
      case "bash":
        console.log(BASH_COMPLETION);
        console.log("\n# Add to ~/.bashrc: eval \"$(appbay completion bash)\"");
        break;
      case "zsh":
        console.log(ZSH_COMPLETION);
        console.log("\n# Add to ~/.zshrc: eval \"$(appbay completion zsh)\"");
        break;
      case "fish":
        console.log(FISH_COMPLETION);
        console.log("\n# Save to: ~/.config/fish/completions/appbay.fish");
        break;
      default:
        console.error(`Unknown shell: ${shell}. Supported: bash, zsh, fish`);
        process.exit(1);
    }
  });
