; OpenPulse installer customisation.
;
; The agent's state — workspace, sessions, memories, credentials, skills, automation history —
; lives in %USERPROFILE%\.openpulse and is deliberately left alone by both install and uninstall.

!macro customUnInstall
  DetailPrint "Leaving your OpenPulse state in $PROFILE\.openpulse untouched."
!macroend

!macro customInstall
  DetailPrint "OpenPulse keeps its agent state in $PROFILE\.openpulse"
!macroend
