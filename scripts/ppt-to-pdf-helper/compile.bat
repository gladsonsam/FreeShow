@echo off
REM Compile PptToPdfHelper.cs with the inbox .NET Framework compiler
REM (same approach as scripts/aero-peek-helper). Run this on Windows.
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:exe /out:..\..\public\assets\bin\ppt-to-pdf-helper.exe PptToPdfHelper.cs
