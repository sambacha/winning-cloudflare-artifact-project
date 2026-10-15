# Sourced (not executed) by the tapes: `source tape/setup.sh`.
# It must be sourced so that the prompt it sets ("$ ") is the prompt of the
# recording shell; the tapes' WaitPattern /\$\s*$/ waits for that prompt.
# It installs nothing.
export PS1='$ '
export PROMPT_COMMAND=''
unset NO_COLOR
export TERM=xterm-256color
# No credential prompt may ever appear on camera.
export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=credential.helper
export GIT_CONFIG_VALUE_0=
# macOS: Objective-C fork-safety aborts in child processes of a recorder.
if [ "$(uname -s)" = "Darwin" ]; then export OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES; fi
cd "$(dirname "${BASH_SOURCE[0]}")/.." || return 1
clear
echo "SETUP COMPLETE: $(node --version) in $(basename "$PWD")/"
