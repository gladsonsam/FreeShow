// PPT/PPTX to PDF via PowerPoint COM. Prebuilt exe (see compile.bat) so the app
// never spawns powershell, which got releases flagged by antivirus (#3476).
// Usage: PptToPdfHelper.exe <input> <output>. Exit: 0 ok, 2 no PowerPoint.
using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

namespace PptToPdfHelper {
    class Program {
        // ppSaveAsPDF = 32 (PpSaveAsFileType), msoFalse = 0, ppAlertsNone = 1
        const int ppSaveAsPDF = 32;
        const int msoFalse = 0;
        const int ppAlertsNone = 1;

        static object Invoke(object target, string name, BindingFlags flags, object[] args) {
            return target.GetType().InvokeMember(name, flags, null, target, args);
        }

        static object Get(object target, string name) {
            return Invoke(target, name, BindingFlags.GetProperty, null);
        }

        static void Set(object target, string name, object value) {
            Invoke(target, name, BindingFlags.SetProperty, new object[] { value });
        }

        static object Call(object target, string name, params object[] args) {
            return Invoke(target, name, BindingFlags.InvokeMethod, args);
        }

        static int Main(string[] args) {
            if (args.Length < 2) {
                Console.Error.WriteLine("Usage: PptToPdfHelper.exe <input.pptx> <output.pdf>");
                return 1;
            }

            string inputPath;
            string outputPath;
            try {
                inputPath = Path.GetFullPath(args[0]);
                outputPath = Path.GetFullPath(args[1]);
            } catch (Exception ex) {
                Console.Error.WriteLine("Invalid paths: " + ex.Message);
                return 1;
            }

            if (!File.Exists(inputPath)) {
                Console.Error.WriteLine("Input file does not exist: " + inputPath);
                return 1;
            }

            try {
                string outDir = Path.GetDirectoryName(outputPath);
                if (!string.IsNullOrEmpty(outDir) && !Directory.Exists(outDir)) Directory.CreateDirectory(outDir);
            } catch (Exception ex) {
                Console.Error.WriteLine("Could not create output folder: " + ex.Message);
                return 1;
            }

            Type pptType = Type.GetTypeFromProgID("PowerPoint.Application");
            if (pptType == null) {
                Console.Error.WriteLine("Microsoft PowerPoint is not installed.");
                return 2;
            }

            object app = null;
            object pres = null;
            try {
                app = Activator.CreateInstance(pptType);
                // hidden + silent: never show UI or blocking dialogs
                Set(app, "Visible", msoFalse);
                Set(app, "DisplayAlerts", ppAlertsNone);

                object presentations = Get(app, "Presentations");
                try {
                    // Open(FileName, ReadOnly, Untitled, WithWindow)
                    pres = Call(presentations, "Open", inputPath, true, false, false);
                    try {
                        Call(pres, "SaveAs", outputPath, ppSaveAsPDF);
                    } finally {
                        try { Call(pres, "Close"); } catch { }
                    }
                } finally {
                    try { Marshal.FinalReleaseComObject(presentations); } catch { }
                }

                if (!File.Exists(outputPath)) {
                    Console.Error.WriteLine("Conversion produced no output: " + outputPath);
                    return 3;
                }
                return 0;
            } catch (Exception ex) {
                Console.Error.WriteLine("Conversion failed: " + ex.Message);
                return 1;
            } finally {
                if (pres != null) {
                    try { Marshal.FinalReleaseComObject(pres); } catch { }
                }
                if (app != null) {
                    try { Call(app, "Quit"); } catch { }
                    try { Marshal.FinalReleaseComObject(app); } catch { }
                }
            }
        }
    }
}
