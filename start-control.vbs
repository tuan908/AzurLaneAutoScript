Option Explicit

Dim shell, files, portArg, portPattern, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
shell.CurrentDirectory = files.GetParentFolderName(WScript.ScriptFullName)

portArg = ""
If WScript.Arguments.Count > 0 Then
    Set portPattern = New RegExp
    portPattern.Pattern = "^[1-9][0-9]{0,4}$"
    If Not portPattern.Test(WScript.Arguments(0)) Then WScript.Quit 2
    If CLng(WScript.Arguments(0)) > 65535 Then WScript.Quit 2
    portArg = " --port " & WScript.Arguments(0)
End If

If Not files.FolderExists("log") Then files.CreateFolder "log"
command = """" & shell.ExpandEnvironmentStrings("%ComSpec%") & """ /d /c start-control.bat" & portArg
WScript.Quit shell.Run(command & " >> log\control-launch.log 2>&1", 0, True)
