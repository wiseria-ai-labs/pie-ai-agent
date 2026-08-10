// Structured parse of `pie doctor --json` stdout.
//
// Deliberately free of WinForms / Drawing / L10n so the console smoke harness
// (DoctorJsonSmoke.cs, compiled + run by build-tray.ps1 after the tray build) can exercise it
// against the REAL .NET Framework JavaScriptSerializer. The ArrayList-vs-object[] gotcha that
// PR #408 review F1 caught only reproduces on real .NET, and this parse layer had zero coverage.
//
// Pure ASCII on purpose: no BOM required, and csc reads it identically under any code page.
using System;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace PieLink
{
    // One structured check row (mirrors daemon DoctorCheck: stable id key / tri-state status /
    // raw English technical detail).
    internal sealed class DoctorCheck
    {
        public string Id;
        public string Status; // "ok" | "warn" | "error"
        public string Detail;
    }

    internal static class DoctorJson
    {
        // Parse stdout `{ "ok": bool, "checks": [ {id,status,detail}, ... ] }`.
        // Any parse exception / shape mismatch -> null (caller falls back to full text); never throws.
        internal static List<DoctorCheck> ParseChecks(string stdout)
        {
            if (string.IsNullOrWhiteSpace(stdout)) return null;
            try
            {
                var json = new JavaScriptSerializer();
                var root = json.Deserialize<Dictionary<string, object>>(stdout.Trim());
                if (root == null || !root.TryGetValue("checks", out var raw)) return null;
                // JavaScriptSerializer deserializes a JSON array as System.Collections.ArrayList,
                // NOT object[] -- an `is object[]` test is always false and silently disables the
                // whole per-check renderer (PR #408 review F1). Accept any IList.
                if (!(raw is System.Collections.IList arr)) return null;
                var list = new List<DoctorCheck>();
                foreach (var item in arr)
                {
                    if (!(item is Dictionary<string, object> c)) continue;
                    var id = c.TryGetValue("id", out var i) ? Convert.ToString(i) : null;
                    var status = c.TryGetValue("status", out var s) ? Convert.ToString(s) : null;
                    var detail = c.TryGetValue("detail", out var d) ? Convert.ToString(d) : "";
                    if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(status)) continue;
                    list.Add(new DoctorCheck { Id = id, Status = status, Detail = detail ?? "" });
                }
                return list;
            }
            catch
            {
                return null;
            }
        }
    }
}
