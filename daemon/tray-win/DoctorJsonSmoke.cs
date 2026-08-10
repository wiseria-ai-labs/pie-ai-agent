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

            // A real `doctor --json` payload: `checks` is a JSON array. Must parse to 5 rows, not
            // null -- the exact F1 regression (object[] test -> always null -> renderer disabled).
            const string ok =
                "{\"ok\":true,\"checks\":[" +
                "{\"id\":\"install_path\",\"status\":\"ok\",\"detail\":\"\"}," +
                "{\"id\":\"vc_runtime\",\"status\":\"ok\",\"detail\":\"\"}," +
                "{\"id\":\"sandbox\",\"status\":\"error\",\"detail\":\"logon failure\"}," +
                "{\"id\":\"nm_chrome\",\"status\":\"ok\",\"detail\":\"\"}," +
                "{\"id\":\"nm_edge\",\"status\":\"ok\",\"detail\":\"\"}]}";
            var checks = DoctorJson.ParseChecks(ok);
            if (checks == null)
            {
                failures++;
                Console.Error.WriteLine("FAIL: ParseChecks returned null for a valid checks array (F1 regression)");
            }
            else
            {
                if (checks.Count != 5)
                {
                    failures++;
                    Console.Error.WriteLine("FAIL: expected 5 checks, got " + checks.Count);
                }
                DoctorCheck sandbox = null;
                foreach (var c in checks)
                {
                    if (c.Id == "sandbox") { sandbox = c; break; }
                }
                if (sandbox == null || sandbox.Status != "error")
                {
                    failures++;
                    Console.Error.WriteLine("FAIL: sandbox check should be parsed with status=error");
                }
                else if (sandbox.Detail != "logon failure")
                {
                    failures++;
                    Console.Error.WriteLine("FAIL: sandbox detail lost during parse");
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
