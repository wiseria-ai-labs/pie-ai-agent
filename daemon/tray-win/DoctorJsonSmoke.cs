// Console smoke test for DoctorJson.ParseChecks -- guards PR #408 review F1.
//
// The bug: JavaScriptSerializer deserializes a JSON array into System.Collections.ArrayList, not
// object[], so the original `raw is object[]` test was always false and the entire per-check
// renderer fell back to raw text (and, worse, always showed the "problems found" title). That
// only reproduces against the real .NET Framework serializer, so this runs at build time.
//
// Compiled + run by build-tray.ps1 after the tray build; a non-zero exit fails the build.
// Console exe, not shipped. Pure ASCII: no BOM needed.
using System;

namespace PieLink
{
    internal static class DoctorJsonSmoke
    {
        private static int Main()
        {
            int failures = 0;

            // A real `doctor --json` payload: `checks` is a JSON array. Must parse to 3 rows, not
            // null -- the exact F1 regression (object[] test -> always null -> renderer disabled).
            // Windows no longer emits sandbox or vc_runtime checks.
            const string ok =
                "{\"ok\":true,\"checks\":[" +
                "{\"id\":\"install_path\",\"status\":\"ok\",\"detail\":\"\"}," +
                "{\"id\":\"nm_chrome\",\"status\":\"error\",\"detail\":\"HKLM key missing\"}," +
                "{\"id\":\"nm_edge\",\"status\":\"ok\",\"detail\":\"\"}]}";
            var checks = DoctorJson.ParseChecks(ok);
            if (checks == null)
            {
                failures++;
                Console.Error.WriteLine("FAIL: ParseChecks returned null for a valid checks array (F1 regression)");
            }
            else
            {
                if (checks.Count != 3)
                {
                    failures++;
                    Console.Error.WriteLine("FAIL: expected 3 checks, got " + checks.Count);
                }
                DoctorCheck nmChrome = null;
                foreach (var c in checks)
                {
                    if (c.Id == "sandbox" || c.Id == "vc_runtime")
                    {
                        failures++;
                        Console.Error.WriteLine("FAIL: " + c.Id + " check must not appear in doctor --json");
                    }
                    if (c.Id == "nm_chrome") { nmChrome = c; }
                }
                if (nmChrome == null || nmChrome.Status != "error")
                {
                    failures++;
                    Console.Error.WriteLine("FAIL: nm_chrome check should be parsed with status=error");
                }
                else if (nmChrome.Detail != "HKLM key missing")
                {
                    failures++;
                    Console.Error.WriteLine("FAIL: nm_chrome detail lost during parse");
                }
            }

            // Malformed / empty / missing-checks -> null so the caller falls back to full text.
            if (DoctorJson.ParseChecks("not json at all") != null)
            {
                failures++;
                Console.Error.WriteLine("FAIL: non-JSON input should return null");
            }
            if (DoctorJson.ParseChecks("") != null)
            {
                failures++;
                Console.Error.WriteLine("FAIL: empty input should return null");
            }
            if (DoctorJson.ParseChecks("{\"ok\":true}") != null)
            {
                failures++;
                Console.Error.WriteLine("FAIL: JSON without a checks key should return null");
            }

            if (failures == 0)
            {
                Console.WriteLine("DoctorJson smoke: all assertions passed");
                return 0;
            }
            Console.Error.WriteLine("DoctorJson smoke: " + failures + " failure(s)");
            return 1;
        }
    }
}
