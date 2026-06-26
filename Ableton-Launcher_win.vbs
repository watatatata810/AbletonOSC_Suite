Set shell = CreateObject("Wscript.Shell")
currentDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptPosition)
shell.CurrentDirectory = currentDir
shell.Run "cmd /c npm run start:launcher", 0, False
