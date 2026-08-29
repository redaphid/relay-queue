' Launches autoseat-start.ps1 with no visible console window.
'
' Same reasoning as speak-mcp/start.vbs and playwright-mcp/start.vbs: a
' scheduled task marked "hidden" still flashes a console window when it starts a
' console process in an interactive session, and this task fires every 5 minutes
' forever, so that flash would be a permanent annoyance on his desktop.
' WScript.Shell.Run with intWindowStyle 0 suppresses it completely.
'
' The autoseat process itself is started by that script with -WindowStyle Hidden
' and its output redirected to a log, so nothing here is ever visible.
Option Explicit
Dim shell, here
Set shell = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
' 0 = hidden window, False = do not wait for it to finish.
shell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & here & "\autoseat-start.ps1""", 0, False
