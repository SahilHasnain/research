' Launches scripts\run-queue.cmd with no console window and waits for it to finish,
' so Task Scheduler shows the task as "Running" for the whole pipeline.
Option Explicit

Dim fso, sh, root, code
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

Set sh = CreateObject("WScript.Shell")
' 0 = hidden window, True = wait for the command to finish
code = sh.Run("""" & root & "\scripts\run-queue.cmd""", 0, True)
WScript.Quit code
