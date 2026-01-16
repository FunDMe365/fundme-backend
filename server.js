<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Admin Dashboard - JoyFund INC.</title>
<style>
:root{
  --accent:#6EC1E4;
  --accent-2:#FF6B81;
  --card-bg:#fff;
  --muted:#666;
  --radius:10px;
  --shadow: 0 6px 18px rgba(18,35,50,0.08);
}
*{box-sizing:border-box}
body{
  margin:0;
  font-family:"Segoe UI", Roboto, Arial, sans-serif;
  background:linear-gradient(135deg,#FFDEE9 0%,#B5FFFC 100%);
  color:#222;
  min-height:100vh;
  display:flex;
  flex-direction:column;
}
header{
  background:var(--accent);
  color:#fff;
  padding:12px 20px;
  display:flex;
  align-items:center;
  justify-content:space-between;
}
header h1{margin:0;font-size:18px;letter-spacing:0.2px;}
header .top-controls{display:flex;gap:10px;align-items:center;}
header .top-controls button{
  background:transparent;
  border:1px solid rgba(255,255,255,.2);
  color:#fff;
  padding:8px 12px;
  border-radius:8px;
  cursor:pointer;
}
header .top-controls button:hover{opacity:.95;transform:translateY(-1px);}
.wrap{display:flex;gap:20px;width:100%;max-width:1200px;margin:20px auto;padding:0 16px;flex:1;}
aside.sidebar{
  width:220px;min-width:200px;background:var(--card-bg);
  border-radius:var(--radius);padding:16px;box-shadow:var(--shadow);
  height:calc(100vh - 120px);position:sticky;top:20px;overflow:auto;
}
.sidebar h3{margin:0 0 12px;color:var(--accent-2);}
.nav-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px;}
.nav-list button{
  text-align:left;background:transparent;border:none;padding:10px 12px;border-radius:8px;
  cursor:pointer;font-weight:600;color:#333;
}
.nav-list button.active{background:linear-gradient(90deg,var(--accent),#8ED9F3);color:#fff;}
main.content{flex:1;min-height:300px;}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px;margin-bottom:18px;}
.card{background:var(--card-bg);border-radius:12px;padding:18px;box-shadow:var(--shadow);text-align:center;}
.card h2{margin:0 0 6px;color:var(--accent-2);font-size:14px;font-weight:700;}
.card .val{font-size:28px;font-weight:800;color:#222;margin-top:6px;}
.panel{background:var(--card-bg);border-radius:12px;padding:14px;box-shadow:var(--shadow);}
.panel h3{margin:0 0 12px;color:var(--accent-2);}
table{width:100%;border-collapse:collapse;font-size:14px;}
table th,table td{padding:8px 10px;text-align:left;border-bottom:1px solid #f0f0f0;vertical-align:top;}
table th{color:var(--muted);font-weight:600;background:transparent;}
.small{font-size:13px;color:var(--muted);}
footer{text-align:center;padding:10px;background:#fff;box-shadow:0 -2px 8px rgba(0,0,0,0.04);font-size:13px;}
@media (max-width:900px){
  .wrap{flex-direction:column;padding:0 12px;}
  aside.sidebar{width:100%;height:auto;position:relative;top:auto;order:2;}
  main.content{order:1;}
}
button.action-btn{padding:6px 10px;margin-right:6px;border:none;border-radius:6px;color:#fff;cursor:pointer;font-weight:700;}
button.approve{background:#00b3ff;}
button.reject{background:#ff4fa3;}
button.neutral{background:#6b7280;}
section{display:none;}
section.active{display:block;}
.notice{
  padding:12px;
  border-radius:10px;
  background:#fff7fb;
  border:1px solid #ffd1e3;
  color:#8a2c55;
  margin:12px 0;
  font-size:14px;
}

/* Simple modal */
.modal-backdrop{
  position:fixed;inset:0;background:rgba(0,0,0,.45);
  display:none;align-items:center;justify-content:center;
  padding:18px;z-index:9999;
}
.modal{
  width:min(820px, 100%);
  background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.25);
  overflow:hidden;
}
.modal header{
  background:linear-gradient(90deg,var(--accent),#8ED9F3);
  padding:12px 16px;
}
.modal header h2{margin:0;color:#fff;font-size:16px;}
.modal .body{padding:14px 16px;}
.modal .row{display:flex;gap:12px;flex-wrap:wrap;}
.modal .col{flex:1;min-width:240px;background:#fafafa;border:1px solid #eee;border-radius:10px;padding:10px;}
.modal .col h4{margin:0 0 8px;color:#333;font-size:14px;}
.modal .actions{padding:12px 16px;display:flex;gap:10px;justify-content:flex-end;border-top:1px solid #eee;background:#fff;flex-wrap:wrap;}
.modal .actions button{border-radius:10px;padding:10px 12px;}
.mono{font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;}
.tag{
  display:inline-block;padding:3px 8px;border-radius:999px;
  background:#f2f2f2;border:1px solid #e9e9e9;color:#444;font-size:12px;font-weight:700;
}
.tag.pending{background:#fff3cd;border-color:#ffeeba;}
.tag.approved{background:#e8fff3;border-color:#c7f6de;}
.tag.denied{background:#ffe1f1;border-color:#ffc6e4;}

/* ===== Campaign details modal ===== */
.modal-backdrop{
  position:fixed; inset:0;
  background:rgba(0,0,0,.55);
  display:none;
  align-items:center;
  justify-content:center;
  padding:18px;
  z-index:9999;
}
.modal{
  width:min(920px, 96vw);
  max-height:90vh;
  overflow:auto;
  background:#0f172a;
  border:1px solid rgba(255,255,255,.12);
  border-radius:16px;
  box-shadow:0 20px 60px rgba(0,0,0,.55);
}
.modal-header{
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap:12px;
  padding:14px 16px;
  border-bottom:1px solid rgba(255,255,255,.10);
}
.modal-body{ padding:16px; }
.modal-grid{
  display:grid;
  grid-template-columns: 1.1fr .9fr;
  gap:16px;
}
@media (max-width: 860px){
  .modal-grid{ grid-template-columns: 1fr; }
}
.kv{
  display:grid;
  grid-template-columns: 140px 1fr;
  gap:8px 12px;
  align-items:start;
  font-size:14px;
}
.kv .k{ opacity:.75; }
.kv .v{ word-break:break-word; }
.camp-img{
  width:100%;
  border-radius:14px;
  border:1px solid rgba(255,255,255,.10);
  background:rgba(255,255,255,.04);
}
.desc-box{
  margin-top:14px;
  padding:12px;
  border-radius:14px;
  border:1px solid rgba(255,255,255,.10);
  background:rgba(255,255,255,.03);
  white-space:pre-wrap;
  line-height:1.35;
}



/* ===== Fix: Campaign View Modal header text contrast ===== */
#campaignModal .modal-header{
  background:linear-gradient(90deg,var(--accent),#8ED9F3);
  color:#fff;
  padding:12px 16px;
}
#campaignModalTitle, #campaignModalMeta{ color:#fff; }
#campaignModalClose{
  background:rgba(255,255,255,.18);
  border:1px solid rgba(255,255,255,.25);
  color:#fff;
  padding:8px 12px;
  border-radius:10px;
  cursor:pointer;
  font-weight:700;
}
#campaignModalClose:hover{ opacity:.95; }
#campaignModal .modal-body{
  padding:14px 16px;
  background:#fff;
  color:#222;
}


/* Campaign View Modal: keep long descriptions visible */
#campaignModalBody{max-height:70vh;overflow:auto;}
#campaignModal{max-height:85vh;overflow:auto;}
</style>
</head>
<body>
<header>
  <h1>JoyFund INC. — Admin</h1>
  <div class="top-controls">
    <div id="adminBadge" class="small">Admin</div>
    <button id="refreshBtn" type="button">Refresh</button>
    <button id="logoutBtn" type="button">Logout</button>
  </div>
</header>

<div class="wrap">
  <aside class="sidebar">
    <h3>Management</h3>
    <nav>
      <ul class="nav-list">
        <li><button id="nav-overview" class="active" type="button">Overview</button></li>
        <li><button id="nav-users" type="button">Users</button></li>
        <li><button id="nav-volunteers" type="button">Volunteers</button></li>
        <li><button id="nav-streetteam" type="button">Street Team</button></li>
        <li><button id="nav-campaigns" type="button">Campaigns</button></li>
        <li><button id="nav-donations" type="button">Donations</button></li>
        <li><button id="nav-joyboost" type="button">JoyBoost</button></li>
        <li><button id="nav-settings" type="button">Settings</button></li>
      </ul>
    </nav>
    <div style="margin-top:18px;">
      <div class="small">Last refresh:</div>
      <div id="lastRefresh" class="small">—</div>
    </div>
  </aside>

  <main class="content" id="mainContent">
    <!-- Overview Section -->
    <section id="overviewSection" class="active">
      <div class="grid">
        <div class="card"><h2>Users</h2><div class="val" id="userCount">—</div><div class="small">From DB</div></div>
        <div class="card"><h2>Volunteers</h2><div class="val" id="volunteerCount">—</div><div class="small">From DB</div></div>
        <div class="card"><h2>Street Team</h2><div class="val" id="streetTeamCount">—</div><div class="small">From DB</div></div>
        <div class="card"><h2>Active Campaigns</h2><div class="val" id="activeCount">—</div><div class="small">From DB</div></div>
        <div class="card"><h2>Approved Campaigns</h2><div class="val" id="approvedCount">—</div><div class="small">From DB</div></div>
        <div class="card"><h2>Pending ID Submissions</h2><div class="val" id="pendingIdCount">—</div><div class="small">From DB</div></div>
        <div class="card"><h2>Approved IDs</h2><div class="val" id="approvedIdCount">—</div><div class="small">From DB</div></div>
        <div class="card"><h2>Closed Campaigns</h2><div class="val" id="closedCount">—</div><div class="small">From DB</div></div>
        <div class="card"><h2>Total Donations</h2><div class="val" id="donationCount">—</div><div class="small">From DB</div></div>
        <div class="card"><h2>Live Visitors</h2><div class="val" id="visitorCount">—</div><div class="small">Realtime</div></div>
        <div class="card"><h2>JoyBoost Apps</h2><div class="val" id="joyboostCount">—</div><div class="small">From DB</div></div>

        <div class="card">
          <h2>Expired Campaigns</h2>
          <div class="val" id="expiredCampaignsCount">0</div>
          <div class="small">Need review / action</div>
          <button class="action-btn neutral" id="viewExpiredBtn" type="button" style="margin-top:10px;width:100%;">Review Expired Campaigns</button>
        </div>
      </div>
    </section>

    <!-- Users Section -->
    <section id="usersSection">
      <h3>Users</h3>
      <table id="usersTable">
        <thead>
          <tr>
            <th>Join Date</th>
            <th>Name</th>
            <th>Email</th>
            <th>ID Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </section>

    <!-- Volunteers Section -->
    <section id="volunteersSection">
      <h3>Volunteers</h3>
      <table id="volunteersTable">
        <thead>
          <tr>
            <th>Date</th>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </section>

    <!-- Street Team -->
    <section id="streetTeamSection">
      <h3>Street Team</h3>
      <table id="streetTeamTable">
        <thead>
          <tr>
            <th>Date</th>
            <th>Name</th>
            <th>Email</th>
            <th>City</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </section>

    <!-- Campaigns Section -->
    <section id="campaignsSection">
      <h3>Campaigns</h3>
      <div class="notice">
        This tab pulls from MongoDB via admin endpoints and allows you to approve/deny.
      </div>
      <table id="campaignsTable">
        <thead>
          <tr><th>Title</th><th>Creator Email</th><th>Goal</th><th>Status</th><th>Created At</th><th>Actions</th></tr>
        </thead>
        <tbody></tbody>
      </table>

      <div class="panel" style="margin-top:14px;">
        <h3>Expired Campaigns (Review)</h3>
        <div class="small" style="margin-bottom:10px;">
          Shows campaigns with <span class="tag">lifecycleStatus: Expired</span>. Track days expired, review status, and outcome.
        </div>

        <table id="expiredCampaignsTable">
          <thead>
            <tr>
              <th>Title</th>
              <th>Creator Email</th>
              <th>Expired</th>
              <th>Days Expired</th>
              <th>Review Status</th>
              <th>Outcome</th>
              <th>Notes</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>

      <div class="panel" style="margin-top:14px;">
        <h3>Identity Verifications (Pending)</h3>
        <div class="small" style="margin-bottom:8px;">
          Approve or deny identity verification submissions. Approved users can start campaigns.
        </div>
        <table id="idvTable">
          <thead>
            <tr><th>Date</th><th>Name</th><th>Email</th><th>ID Image</th><th>Status</th><th>Actions</th></tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>

      <div class="panel" style="margin-top:14px;">
        <h3>Identity Verifications (Approved)</h3>
        <div class="small" style="margin-bottom:8px;">
          Read-only list of approved identity verifications.
        </div>
        <table id="idvApprovedTable">
          <thead>
            <tr><th>Date</th><th>Name</th><th>Email</th><th>ID Image</th><th>Status</th><th>Actions</th></tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>

    </section>

    <!-- Donations Section -->
    <section id="donationsSection">
      <h3>Donations</h3>
      <div class="notice">
        This table is wired to <strong>GET /api/donations</strong>.
      </div>
      <table id="donationsTable">
        <thead>
          <tr><th>Date</th><th>Donor</th><th>Amount</th><th>Campaign</th></tr>
        </thead>
        <tbody></tbody>
      </table>
    </section>

    <!-- JoyBoost Section -->
    <section id="joyboostSection">
      <h3>JoyBoost — Relief Applications</h3>
      <div class="notice">
        Approve or deny JoyBoost relief requests. Approved requests should trigger the payment-link email from the backend.
      </div>

      <div class="panel" style="margin-bottom:12px;">
        <h3>Applications</h3>
        <div class="small" style="margin-bottom:10px;">
          Statuses: <span class="tag pending">Pending</span> <span class="tag approved">Approved</span> <span class="tag denied">Denied</span>
        </div>
        <table id="joyboostTable">
          <thead>
            <tr>
              <th>Date</th>
              <th>Applicant</th>
              <th>Campaign</th>
              <th>Goal</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>

      <div class="panel" style="margin-top:14px;">
        <h3>Supporters (Active Subscriptions)</h3>
        <div class="small" style="margin-bottom:10px;">
          These are users actively supporting JoyBoost via Stripe subscriptions.
        </div>
        <table id="joyboostSupportersTable">
          <thead>
            <tr>
              <th>Started</th>
              <th>Email</th>
              <th>Tier</th>
              <th>Status</th>
              <th>Stripe Sub ID</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </section>

    <!-- Settings Section -->
    <section id="settingsSection">
      <h3>Settings</h3>
      <p>Admin settings and site management options:</p>
      <div><label><input type="checkbox" id="toggleDemoMode"> Enable Demo Mode</label></div>
      <div><label><input type="checkbox" id="toggleVisitorLogging"> Enable Visitor Logging</label></div>
      <div><label><input type="checkbox" id="toggleProfanityFilter"> Enable Profanity Filter</label></div>
      <div><label><input type="checkbox" id="toggleCampaignApproval"> Require Campaign Approval</label></div>
      <div><label><input type="checkbox" id="toggleAutoDonationEmail"> Auto-send Donation Receipts</label></div>
      <div><label><input type="checkbox" id="toggleUserRegistration"> Allow User Registration</label></div>
      <div><label><input type="checkbox" id="toggleVolunteerApplications"> Accept Volunteer Applications</label></div>
      <div><label><input type="checkbox" id="toggleCampaignVisibility"> Publicly Display Campaigns</label></div>
      <div><label><input type="checkbox" id="toggleEmailNotifications"> Enable Email Notifications</label></div>
    </section>
  </main>
</div>

<footer>&copy; 2025 JoyFund INC.</footer>

<!-- JoyBoost Modal -->
<div class="modal-backdrop" id="jbModalBackdrop" aria-hidden="true">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="jbModalTitle">
    <header><h2 id="jbModalTitle">JoyBoost Application</h2></header>

    <div class="body">
      <div class="row">
        <div class="col">
          <h4>Applicant</h4>
          <div><strong id="jbApplicantName">—</strong></div>
          <div class="small" id="jbApplicantEmail">—</div>
          <div style="margin-top:8px"><span class="tag" id="jbStatusTag">—</span></div>
        </div>

        <div class="col">
          <h4>Campaign</h4>
          <div><strong id="jbCampaignTitle">—</strong></div>
          <div class="small" id="jbCampaignRef">—</div>
          <div class="small" id="jbCampaignLinkWrap">—</div>
        </div>

        <div class="col">
          <h4>Request</h4>
          <div><strong id="jbGoal">—</strong></div>
          <div class="small" id="jbJoy">—</div>
          <div class="small" id="jbCreatedAt">—</div>
        </div>
      </div>

      <div class="panel" style="margin-top:12px;">
        <h3>Notes</h3>
        <div class="small" id="jbNotes" style="white-space:pre-wrap">—</div>
      </div>

      <div class="panel" style="margin-top:12px;">
        <h3>Admin Notes (internal)</h3>
        <textarea id="jbAdminNotes" rows="4" style="width:100%;padding:10px;border-radius:10px;border:1px solid #e5e5e5;"></textarea>
        <div class="small" style="margin-top:6px;">Optional: saved internally (only if your backend stores it).</div>
      </div>
    </div>

    <div class="actions">
      <button class="action-btn neutral" id="jbCloseBtn" type="button">Close</button>
      <button class="action-btn reject" id="jbDeclineBtn" type="button">Deny</button>
      <button class="action-btn approve" id="jbApproveBtn" type="button">Approve</button>
    </div>
  </div>
</div>

<!-- Expired Campaign Modal -->
<div class="modal-backdrop" id="expModalBackdrop" aria-hidden="true">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="expModalTitle">
    <header><h2 id="expModalTitle">Expired Campaign Review</h2></header>

    <div class="body">
      <div class="row">
        <div class="col">
          <h4>Campaign</h4>
          <div><strong id="expTitle">—</strong></div>
          <div class="small" id="expEmail">—</div>
          <div class="small" id="expDates">—</div>
          <div style="margin-top:8px"><span class="tag" id="expLifeTag">Expired</span></div>
        </div>

        <div class="col">
          <h4>Review</h4>

          <div class="small" style="margin:6px 0 4px;">Review Status</div>
          <select id="expReviewStatus" style="width:100%;padding:10px;border-radius:10px;border:1px solid #e5e5e5;">
            <option value="">(none)</option>
            <option value="Needs Review">Needs Review</option>
            <option value="In Review">In Review</option>
            <option value="Reviewed">Reviewed</option>
          </select>

          <div class="small" style="margin:10px 0 4px;">Outcome</div>
          <select id="expOutcome" style="width:100%;padding:10px;border-radius:10px;border:1px solid #e5e5e5;">
            <option value="">(none)</option>
            <option value="Closed">Closed</option>
            <option value="Extended">Extended</option>
            <option value="Reopened">Reopened</option>
          </select>
        </div>
      </div>

      <div class="panel" style="margin-top:12px;">
        <h3>Admin Notes</h3>
        <textarea id="expNotes" rows="6" style="width:100%;padding:10px;border-radius:10px;border:1px solid #e5e5e5;"></textarea>
        <div class="small" style="margin-top:6px;">Saved on the campaign document (internal admin-only).</div>
      </div>
    </div>

    <div class="actions">
      <select id="expRestoreDays" style="padding:10px;border-radius:10px;border:1px solid #e5e5e5;">
        <option value="">Restore…</option>
        <option value="7">Restore 7 days</option>
        <option value="14">Restore 14 days</option>
        <option value="30">Restore 30 days</option>
      </select>

      <button class="action-btn approve" id="expRestoreBtn" type="button">Restore</button>
      <button class="action-btn neutral" id="expCloseBtn" type="button">Close</button>
      <button class="action-btn approve" id="expSaveBtn" type="button">Save Review</button>
    </div>
  </div>
</div>

<!-- Campaign Details Modal -->
<div class="modal-backdrop" id="campModalBackdrop" aria-hidden="true">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="campModalTitle">
    <header><h2 id="campModalTitle">Campaign Details</h2></header>

    <div class="body">
      <div class="row">
        <div class="col">
          <h4>Campaign</h4>
          <div><strong id="campTitle">—</strong></div>
          <div class="small" id="campStatusLine">—</div>
          <div style="margin-top:8px"><span class="tag" id="campStatusTag">—</span></div>
        </div>

        <div class="col">
          <h4>Creator</h4>
          <div><strong id="campCreatorName">—</strong></div>
          <div class="small" id="campCreatorEmail">—</div>
          <div class="small" id="campCreatedAt">—</div>
        </div>

        <div class="col">
          <h4>Location / Category</h4>
          <div><strong id="campLocation">—</strong></div>
          <div class="small" id="campCategory">—</div>
          <div class="small" id="campGoal">—</div>
        </div>
      </div>

      <div class="panel" style="margin-top:12px;">
        <h3>Description</h3>
        <div class="small" id="campDescription" style="white-space:pre-wrap">—</div>
      </div>

      <div class="panel" style="margin-top:12px;">
        <h3>Links / Media</h3>
        <div class="small" id="campImageWrap">—</div>
        <div class="small" id="campPublicLinkWrap" style="margin-top:8px;">—</div>
        <div class="small mono" id="campIdLine" style="margin-top:8px;">—</div>
      </div>
    </div>

    <div class="actions">
      <button class="action-btn neutral" id="campCloseBtn" type="button">Close</button>
    </div>
  </div>
</div>

<script>
/**
 * Cleaned + fixed version of your current admin dashboard.
 * Based on your uploaded file, this fixes the broken HTML/script placement
 * and keeps the identity verification approval workflow intact.
 */

const backendURL = "https://api.fundasmile.net";
const adminLoginPage = "portal-7k3p9.html"; // your hidden admin-login filename

async function safeReadJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function escapeHtml(v) {
  const s = String(v ?? "");
  return s.replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[ch]));
}

async function fetchCampaignDetails(id) {
  // Best-effort: try a dedicated details endpoint if your backend has it.
  // If not, we'll fall back to the campaign object we already have in the table.
  try {
    const res = await fetch(`${backendURL}/api/admin/campaigns/${encodeURIComponent(id)}`, {
      credentials: "include",
      cache: "no-store"
    });
    if (!res.ok) return null;
    const data = await safeReadJson(res);
    // support multiple shapes
    return data?.campaign || data?.data || data || null;
  } catch (e) {
    return null;
  }
}

// ==================== ADMIN SESSION CHECK ====================
async function checkAdminSession() {
  try {
    const res = await fetch(`${backendURL}/api/admin-check`, {
      credentials: "include",
      cache: "no-store"
    });

    const data = await res.json().catch(() => ({}));
    console.log("admin-check:", res.status, data);

    if (!res.ok || data.admin !== true) {
      window.location.href = adminLoginPage;
      return false;
    }
    return true;
  } catch (err) {
    console.error("admin-check error:", err);
    window.location.href = adminLoginPage;
    return false;
  }
}

// ==================== LOGOUT ====================
document.getElementById("logoutBtn").addEventListener("click", async () => {
  try {
    await fetch(`${backendURL}/api/admin-logout`, { method: "POST", credentials: "include" });
  } catch (e) {
    console.warn("Logout failed", e);
  }
  window.location.href = adminLoginPage;
});

// ==================== TAB NAVIGATION ====================
const tabs = document.querySelectorAll(".nav-list button");
const sections = document.querySelectorAll("main.content section");

tabs.forEach(tab => {
  tab.addEventListener("click", () => {
    tabs.forEach(t => t.classList.remove("active"));
    sections.forEach(s => s.classList.remove("active"));
    tab.classList.add("active");

    const idMap = {
      "nav-overview": "overviewSection",
      "nav-users": "usersSection",
      "nav-volunteers": "volunteersSection",
      "nav-streetteam": "streetTeamSection",
      "nav-campaigns": "campaignsSection",
      "nav-donations": "donationsSection",
      "nav-joyboost": "joyboostSection",
      "nav-settings": "settingsSection"
    };

    const sectionId = idMap[tab.id];
    document.getElementById(sectionId).classList.add("active");

    if (sectionId === "overviewSection") refreshDashboard();
    if (sectionId === "usersSection") loadUsers();
    if (sectionId === "volunteersSection") loadVolunteers();
    if (sectionId === "streetTeamSection") loadStreetTeam();

    if (sectionId === "campaignsSection") {
      loadCampaigns();
      loadPendingIdVerifications();
      loadApprovedIdVerifications();
      loadExpiredCampaigns();
    }

    if (sectionId === "donationsSection") loadDonations();

    if (sectionId === "joyboostSection") {
      loadJoyBoostApps();
      loadJoyBoostSupporters();
    }
  });
});

// ==================== ADMIN ACTION HELPERS ====================
async function setCampaignStatus(id, status) {
  const res = await fetch(`${backendURL}/api/admin/campaigns/${encodeURIComponent(id)}/status`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status })
  });
  const data = await safeReadJson(res);
  if (!res.ok) throw new Error(data?.message || "Failed to update campaign");
  return data;
}

async function approveIdv(id) {
  const res = await fetch(`${backendURL}/api/admin/id-verifications/${encodeURIComponent(id)}/approve`, {
    method: "PATCH",
    credentials: "include"
  });
  const data = await safeReadJson(res);
  if (!res.ok) throw new Error(data?.message || "Approve failed");
  return data;
}

async function denyIdv(id) {
  const reason = prompt("Reason for denial? (optional)") || "";
  const res = await fetch(`${backendURL}/api/admin/id-verifications/${encodeURIComponent(id)}/deny`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason })
  });
  const data = await safeReadJson(res);
  if (!res.ok) throw new Error(data?.message || "Deny failed");
  return data;
}

// ==================== JOYBOOST ====================
function jbTagClass(status) {
  const s = String(status || "").toLowerCase();
  if (s === "pending") return "pending";
  if (s === "approved") return "approved";
  if (s === "denied") return "denied";
  return "";
}

async function setJoyBoostStatus(requestId, status, extra = {}) {
  const res = await fetch(`${backendURL}/api/admin/joyboost/requests/${encodeURIComponent(requestId)}/status`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: String(status || "").trim(), ...extra })
  });

  const data = await safeReadJson(res);
  if (!res.ok) throw new Error(data?.message || "Failed to update JoyBoost request");
  return data;
}

async function loadJoyBoostApps() {
  const tbody = document.querySelector("#joyboostTable tbody");
  if (!tbody) return;

  tbody.innerHTML = "";
  try {
    const res = await fetch(`${backendURL}/api/admin/joyboost/requests`, {
      credentials: "include",
      cache: "no-store"
    });
    const data = await safeReadJson(res);
    const apps = Array.isArray(data?.requests) ? data.requests : [];

    apps.forEach(app => {
      const id = app._id || app.id;
      const status = app.status || "Pending";

      const goal = app.goal || "—";
      const campaignLabel = app.campaignTitle || app.campaignId || "—";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${app.createdAt ? new Date(app.createdAt).toLocaleString() : "—"}</td>
        <td>${app.name || "—"}<div class="small">${app.email || "—"}</div></td>
        <td>${campaignLabel}</td>
        <td>${goal}</td>
        <td><span class="tag ${jbTagClass(status)}">${status}</span></td>
        <td>
          <button class="action-btn neutral" type="button">View</button>
          <button class="action-btn approve" type="button">Approve</button>
          <button class="action-btn reject" type="button">Deny</button>
        </td>
      `;
      tbody.appendChild(tr);

      const [viewBtn, approveBtn, denyBtn] = tr.querySelectorAll("button");

      viewBtn.addEventListener("click", () => openJoyBoostModal(app));

      approveBtn.addEventListener("click", async () => {
        try {
          approveBtn.disabled = true; denyBtn.disabled = true; viewBtn.disabled = true;
          const adminNotes = prompt("Optional internal notes for this approval?") || "";
          await setJoyBoostStatus(id, "Approved", adminNotes ? { adminNotes } : {});
          await loadJoyBoostApps();
          await loadJoyBoostCount();
        } catch (e) {
          alert(e.message || "Approve failed");
        } finally {
          approveBtn.disabled = false; denyBtn.disabled = false; viewBtn.disabled = false;
        }
      });

      denyBtn.addEventListener("click", async () => {
        try {
          approveBtn.disabled = true; denyBtn.disabled = true; viewBtn.disabled = true;
          const reason = prompt("Reason for denial? (optional)") || "";
          await setJoyBoostStatus(id, "Denied", reason ? { reason } : {});
          await loadJoyBoostApps();
          await loadJoyBoostCount();
        } catch (e) {
          alert(e.message || "Deny failed");
        } finally {
          approveBtn.disabled = false; denyBtn.disabled = false; viewBtn.disabled = false;
        }
      });
    });
  } catch (err) {
    console.error("loadJoyBoostApps error:", err);
  }
}

async function loadJoyBoostSupporters() {
  const tbody = document.querySelector("#joyboostSupportersTable tbody");
  if (!tbody) return;

  tbody.innerHTML = "";

  try {
    const res = await fetch(`${backendURL}/api/admin/joyboost/supporters`, {
      credentials: "include",
      cache: "no-store"
    });

    const data = await safeReadJson(res);
    const supporters = Array.isArray(data?.supporters) ? data.supporters : [];

    supporters.forEach(s => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${s.createdAt ? new Date(s.createdAt).toLocaleString() : "—"}</td>
        <td>${s.supporterEmail || "—"}</td>
        <td>${s.tier || "—"}</td>
        <td>${s.status || "active"}</td>
        <td class="mono">${s.stripeSubscriptionId || "—"}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error("loadJoyBoostSupporters error:", err);
  }
}

// Modal wiring (JoyBoost)
const jbModalBackdrop = document.getElementById("jbModalBackdrop");
const jbCloseBtn = document.getElementById("jbCloseBtn");
const jbDeclineBtn = document.getElementById("jbDeclineBtn");
const jbApproveBtn = document.getElementById("jbApproveBtn");
const jbAdminNotes = document.getElementById("jbAdminNotes");

let jbCurrent = null;

function closeJoyBoostModal() {
  jbModalBackdrop.style.display = "none";
  jbModalBackdrop.setAttribute("aria-hidden", "true");
  jbCurrent = null;
  jbAdminNotes.value = "";
}
jbCloseBtn.addEventListener("click", closeJoyBoostModal);
jbModalBackdrop.addEventListener("click", (e) => {
  if (e.target === jbModalBackdrop) closeJoyBoostModal();
});

function openJoyBoostModal(app) {
  jbCurrent = app;
  jbModalBackdrop.style.display = "flex";
  jbModalBackdrop.setAttribute("aria-hidden", "false");

  const status = app.status || "Pending";
  const tag = document.getElementById("jbStatusTag");
  tag.innerText = status;
  tag.className = `tag ${jbTagClass(status)}`;

  document.getElementById("jbApplicantName").innerText = app.name || "—";
  document.getElementById("jbApplicantEmail").innerText = app.email || "—";

  document.getElementById("jbCampaignTitle").innerText = app.campaignTitle || "—";
  document.getElementById("jbCampaignRef").innerText = app.campaignId || "—";

  const link = (app.campaignLink || "").trim();
  document.getElementById("jbCampaignLinkWrap").innerHTML =
    link ? `<a href="${link}" target="_blank" rel="noopener">Open campaign link</a>` : "—";

  document.getElementById("jbGoal").innerText = app.goal || "—";
  document.getElementById("jbJoy").innerText = app.joy ? `Joy: ${app.joy}` : "Joy: —";
  document.getElementById("jbCreatedAt").innerText =
    app.createdAt ? `Submitted: ${new Date(app.createdAt).toLocaleString()}` : "Submitted: —";

  document.getElementById("jbNotes").innerText = (app.notes || "—");
  jbAdminNotes.value = app.adminNotes || "";
}

jbDeclineBtn.addEventListener("click", async () => {
  if (!jbCurrent) return;
  try {
    jbDeclineBtn.disabled = true;
    const reason = prompt("Reason for denial? (optional)") || "";
    await setJoyBoostStatus(jbCurrent._id || jbCurrent.id, "Denied", reason ? { reason } : {});
    closeJoyBoostModal();
    await loadJoyBoostApps();
    await loadJoyBoostCount();
  } catch (e) {
    alert(e.message || "Deny failed");
  } finally {
    jbDeclineBtn.disabled = false;
  }
});

jbApproveBtn.addEventListener("click", async () => {
  if (!jbCurrent) return;
  try {
    jbApproveBtn.disabled = true;
    const adminNotes = jbAdminNotes.value.trim();
    await setJoyBoostStatus(jbCurrent._id || jbCurrent.id, "Approved", adminNotes ? { adminNotes } : {});
    closeJoyBoostModal();
    await loadJoyBoostApps();
    await loadJoyBoostCount();
  } catch (e) {
    alert(e.message || "Approve failed");
  } finally {
    jbApproveBtn.disabled = false;
  }
});

// ==================== CAMPAIGNS ====================
async function loadCampaigns() {
  try {
    const res = await fetch(`${backendURL}/api/admin/campaigns`, { credentials: "include", cache: "no-store" });
    const data = await safeReadJson(res);
    const campaigns = Array.isArray(data?.campaigns) ? data.campaigns : [];

    const tbody = document.querySelector("#campaignsTable tbody");
    tbody.innerHTML = "";

    campaigns.forEach(c => {
      const id = c._id || c.id || c.Id;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${c.title || "Untitled"}</td>
        <td>${c.email || c.Email || "—"}</td>
        <td>${c.goal ?? "—"}</td>
        <td>${c.status || "—"}</td>
        <td>${c.createdAt ? new Date(c.createdAt).toLocaleString() : "—"}</td>
        <td>
          <button class="action-btn neutral" type="button" title="View campaign details">View</button>
          <button class="approve action-btn" type="button" title="Approve campaign">Approve</button>
          <button class="reject action-btn" type="button" title="Deny campaign">Reject</button>
        </td>
      `;
      tbody.appendChild(tr);

      const viewBtn = tr.querySelector("button.neutral");
      const approveBtn = tr.querySelector("button.approve");
      const rejectBtn = tr.querySelector("button.reject");

      // Disable actions once a campaign is already decided / live / closed
      const s = String(c.status || "").toLowerCase();
      if (s === "approved" || s === "denied" || s === "active" || s === "closed") {
        approveBtn.disabled = true;
        rejectBtn.disabled = true;
      }

      
      viewBtn?.addEventListener("click", async () => {
        try {
          viewBtn.disabled = true;
          const details = await fetchCampaignDetails(id);
          if (typeof window.openCampaignModal === "function") window.openCampaignModal(details || c);
        } catch (e) {
          if (typeof window.openCampaignModal === "function") window.openCampaignModal(c);
        } finally {
          viewBtn.disabled = false;
        }
      });

approveBtn.addEventListener("click", async () => {
        try {
          approveBtn.disabled = true; rejectBtn.disabled = true;
          await setCampaignStatus(id, "Approved");
          await loadCampaigns();
        } catch (e) {
          alert(e.message || "Failed to approve");
        } finally {
          approveBtn.disabled = false; rejectBtn.disabled = false;
        }
      });

      rejectBtn.addEventListener("click", async () => {
        try {
          approveBtn.disabled = true; rejectBtn.disabled = true;
          await setCampaignStatus(id, "Denied");
          await loadCampaigns();
        } catch (e) {
          alert(e.message || "Failed to deny");
        } finally {
          approveBtn.disabled = false; rejectBtn.disabled = false;
        }
      });
    });

    const active = campaigns.filter(c => (c.status || "").toLowerCase() === "active").length;
    const approved = campaigns.filter(c => (c.status || "").toLowerCase() === "approved").length;
    const closed = campaigns.filter(c => (c.status || "").toLowerCase() === "closed").length;

    document.getElementById("activeCount").innerText = String(active);
    const apprEl = document.getElementById("approvedCount");
    if (apprEl) apprEl.innerText = String(approved);
    document.getElementById("closedCount").innerText = String(closed);
  } catch (err) {
    console.error("loadCampaigns error:", err);
  }
}

// ==================== ID VERIFICATIONS (PENDING LIST) ====================
async function loadPendingIdVerifications() {
  try {
    const res = await fetch(`${backendURL}/api/admin/id-verifications?status=Pending`, {
      credentials: "include",
      cache: "no-store"
    });
    const data = await safeReadJson(res);
    const rows = Array.isArray(data?.data) ? data.data : [];

    const tbody = document.querySelector("#idvTable tbody");
    if (!tbody) return;
    tbody.innerHTML = "";

    rows.forEach(r => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${r.createdAt ? new Date(r.createdAt).toLocaleString() : "—"}</td>
        <td>${r.name || "—"}</td>
        <td>${r.email || "—"}</td>
        <td>${r.url ? `<a href="${r.url}" target="_blank" rel="noopener">View</a>` : "—"}</td>
        <td>${r.status || "Pending"}</td>
        <td>
          <button class="approve action-btn" type="button" title="Approve ID Verification">Approve</button>
          <button class="reject action-btn" type="button" title="Deny ID Verification">Reject</button>
        </td>
      `;
      tbody.appendChild(tr);

      const approveBtn = tr.querySelector("button.approve");
      const rejectBtn = tr.querySelector("button.reject");

      approveBtn.addEventListener("click", async () => {
        try {
          approveBtn.disabled = true; rejectBtn.disabled = true;
          await approveIdv(r._id || r.id);
          await Promise.all([loadPendingIdVerifications(), loadUsers()]);
        } catch (e) {
          alert(e.message || "Approve failed");
        } finally {
          approveBtn.disabled = false; rejectBtn.disabled = false;
        }
      });

      rejectBtn.addEventListener("click", async () => {
        try {
          approveBtn.disabled = true; rejectBtn.disabled = true;
          await denyIdv(r._id || r.id);
          await Promise.all([loadPendingIdVerifications(), loadUsers()]);
        } catch (e) {
          alert(e.message || "Deny failed");
        } finally {
          approveBtn.disabled = false; rejectBtn.disabled = false;
        }
      });
    });
  } catch (err) {
    console.error("loadPendingIdVerifications error:", err);
  }
}


async function loadPendingIdCount() {
  try {
    const res = await fetch(`${backendURL}/api/admin/id-verifications?status=Pending`, {
      credentials: "include",
      cache: "no-store"
    });
    const data = await safeReadJson(res);
    const rows = Array.isArray(data?.data) ? data.data : [];
    const el = document.getElementById("pendingIdCount");
    if (el) el.innerText = String(rows.length);
  } catch (err) {
    console.error("loadPendingIdCount error:", err);
    const el = document.getElementById("pendingIdCount");
    if (el) el.innerText = "0";
  }
}


async function loadApprovedIdCount() {
  try {
    const res = await fetch(`${backendURL}/api/admin/id-verifications?status=Approved`, {
      credentials: "include",
      cache: "no-store"
    });
    const data = await safeReadJson(res);
    const rows = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.verifications) ? data.verifications : (Array.isArray(data) ? data : []));
    const el = document.getElementById("approvedIdCount");
    if (el) el.innerText = String(rows.length ?? 0);
  } catch (e) {
    const el = document.getElementById("approvedIdCount");
    if (el) el.innerText = "—";
  }
}

async function loadApprovedIdVerifications() {
  const tbody = document.querySelector("#idvApprovedTable tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  try {
    const res = await fetch(`${backendURL}/api/admin/id-verifications?status=Approved`, {
      credentials: "include",
      cache: "no-store"
    });
    const data = await safeReadJson(res);
    const rows = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.verifications) ? data.verifications : (Array.isArray(data) ? data : []));

    rows.forEach(v => {
      const createdAtRaw = v?.createdAt || v?.CreatedAt || v?.created_at || v?.Date || v?.date;
      const createdAt = createdAtRaw ? new Date(createdAtRaw).toLocaleString() : "—";

      const name = v?.name || v?.Name || "—";
      const email = v?.email || v?.Email || "—";
      const status = v?.status || v?.Status || "Approved";

      const img = v?.IDPhotoURL || v?.idPhotoUrl || v?.photoUrl || v?.url || v?.fileUrl || v?.FileURL || v?.IdFileUrl || v?.idFile || "";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(createdAt)}</td>
        <td>${escapeHtml(name)}</td>
        <td>${escapeHtml(email)}</td>
        <td>${img ? `<a href="${escapeHtml(img)}" target="_blank" rel="noopener">View</a>` : "—"}</td>
        <td><span class="tag approved">${escapeHtml(status)}</span></td>
        <td>
          <button class="action-btn neutral" type="button">View</button>
        </td>
      `;
      tbody.appendChild(tr);

      const viewBtn = tr.querySelector("button");
      viewBtn.addEventListener("click", () => {
        if (img) window.open(img, "_blank", "noopener");
        else alert("No ID image found for this record.");
      });
    });
  } catch (err) {
    console.error("loadApprovedIdVerifications error:", err);
  }
}

// ==================== DONATIONS ====================
function pickDonationAmountRaw(d) {
  return (
    d.chargedAmount ??
    d.originalDonation ??
    d.amount ??
    d.amountTotal ??
    d.amount_total ??
    d.amountCents ??
    d.amount_cents ??
    d.total ??
    d.value ??
    0
  );
}
function normalizeDonationAmountToDollars(d) {
  let raw = pickDonationAmountRaw(d);
  if (typeof raw === "string") raw = raw.replace(/[^0-9.-]/g, "");
  let n = Number(raw);
  if (!Number.isFinite(n)) n = 0;

  const looksStripe =
    !!(d.currency || d.paymentIntentId || d.payment_intent || d.checkoutSessionId || d.sessionId || d.stripeSessionId);

  if (looksStripe && Number.isInteger(n)) return n / 100;
  return n;
}
function formatUSD(n) { return `$${Number(n || 0).toFixed(2)}`; }

async function loadDonations() {
  try {
    const res = await fetch(`${backendURL}/api/donations`, { credentials: "include", cache: "no-store" });
    const data = await safeReadJson(res);
    const donations = (Array.isArray(data?.donations) ? data.donations : []).filter(d => {
      return !(
        d.type === "owner_test" ||
        d.metadata?.type === "owner_test" ||
        d.description?.toLowerCase?.().includes("owner test")
      );
    });

    document.getElementById("donationCount").innerText = String(donations.length);

    const tbody = document.querySelector("#donationsTable tbody");
    tbody.innerHTML = "";

    donations.forEach((d) => {
      const dollars = normalizeDonationAmountToDollars(d);

      const campaignLabel =
        d.campaignTitle ||
        d.campaignName ||
        d.campaignSlug ||
        d.campaignId ||
        "—";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${d.date ? new Date(d.date).toLocaleString() : (d.createdAt ? new Date(d.createdAt).toLocaleString() : "—")}</td>
        <td>${d.name || "—"} (${d.email || "—"})</td>
        <td>${formatUSD(dollars)}</td>
        <td>${campaignLabel}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error("loadDonations error:", err);
  }
}

// ==================== STATS ====================
async function loadAdminStats() {
  const res = await fetch(`${backendURL}/api/admin/stats`, {
    credentials: "include",
    cache: "no-store"
  });
  const data = await safeReadJson(res);

  if (!res.ok || !data?.success) {
    throw new Error(data?.message || "Failed to load admin stats");
  }

  document.getElementById("userCount").innerText = String(data.users ?? 0);
  document.getElementById("volunteerCount").innerText = String(data.volunteers ?? 0);
  document.getElementById("streetTeamCount").innerText = String(data.streetTeam ?? 0);
}

async function loadJoyBoostCount() {
  try {
    const res = await fetch(`${backendURL}/api/admin/joyboost/requests`, {
      credentials: "include",
      cache: "no-store"
    });
    const data = await safeReadJson(res);
    const apps = Array.isArray(data?.requests) ? data.requests : [];
    const el = document.getElementById("joyboostCount");
    if (el) el.innerText = String(apps.length);
  } catch (err) {
    console.error("loadJoyBoostCount error:", err);
  }
}

// ==================== VOLUNTEERS / STREET TEAM / USERS ====================
async function loadVolunteers() {
  try {
    const res = await fetch(`${backendURL}/api/admin/volunteers`, {
      credentials: "include",
      cache: "no-store"
    });

    const data = await safeReadJson(res);
    const volunteers = Array.isArray(data?.volunteers) ? data.volunteers : [];

    const tbody = document.querySelector("#volunteersTable tbody");
    if (!tbody) return;

    tbody.innerHTML = "";

    volunteers.forEach(v => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${v.createdAt ? new Date(v.createdAt).toLocaleString() : "—"}</td>
        <td>${v.name || "—"}</td>
        <td>${v.email || "—"}</td>
        <td>${v.role || "—"}</td>
        <td>${v.reason || v.availability || "—"}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error("loadVolunteers error:", err);
  }
}

async function loadStreetTeam() {
  try {
    const res = await fetch(`${backendURL}/api/admin/street-team`, {
      credentials: "include",
      cache: "no-store"
    });
    const data = await safeReadJson(res);
    const rows = Array.isArray(data?.streetTeam) ? data.streetTeam : [];

    const tbody = document.querySelector("#streetTeamTable tbody");
    if (!tbody) return;

    tbody.innerHTML = "";

    rows.forEach(r => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${r.createdAt ? new Date(r.createdAt).toLocaleString() : "—"}</td>
        <td>${r.name || "—"}</td>
        <td>${r.email || "—"}</td>
        <td>${r.city || "—"}</td>
        <td>${r.reason || r.hoursAvailable || "—"}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error("loadStreetTeam error:", err);
  }
}

async function loadUsers() {
  try {
    const res = await fetch(`${backendURL}/api/admin/users`, { credentials: "include", cache: "no-store" });
    const data = await safeReadJson(res);
    const users = Array.isArray(data?.users) ? data.users : [];

    const tbody = document.querySelector("#usersTable tbody");
    tbody.innerHTML = "";

    users.forEach(u => {
      const idvId = u.idvId || u.idVerificationId || u.idv?._id;
      const idvStatus = (u.idvStatus || u.identityStatus || u.idv?.status || "").toString();

      const canDecide = idvId && idvStatus.toLowerCase() === "pending";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${u.joinDate ? new Date(u.joinDate).toLocaleString() : (u.createdAt ? new Date(u.createdAt).toLocaleString() : "—")}</td>
        <td>${u.name || "—"}</td>
        <td>${u.email || "—"}</td>
        <td>${idvStatus || "—"}</td>
        <td>
          ${
            canDecide
              ? `<button class="approve action-btn" type="button">Approve</button>
                 <button class="reject action-btn" type="button">Deny</button>`
              : "—"
          }
        </td>
      `;
      tbody.appendChild(tr);

      if (canDecide) {
        const approveBtn = tr.querySelector(".approve");
        const denyBtn = tr.querySelector(".reject");

        approveBtn.onclick = async () => {
          approveBtn.disabled = true;
          denyBtn.disabled = true;
          try {
            await approveIdv(idvId);
            await Promise.all([loadUsers(), loadPendingIdVerifications()]);
          } catch (e) {
            alert(e.message || "Approve failed");
          } finally {
            approveBtn.disabled = false;
            denyBtn.disabled = false;
          }
        };

        denyBtn.onclick = async () => {
          approveBtn.disabled = true;
          denyBtn.disabled = true;
          try {
            await denyIdv(idvId);
            await Promise.all([loadUsers(), loadPendingIdVerifications()]);
          } catch (e) {
            alert(e.message || "Deny failed");
          } finally {
            approveBtn.disabled = false;
            denyBtn.disabled = false;
          }
        };
      }
    });
  } catch (err) {
    console.error("loadUsers error:", err);
  }
}

// ===== Live visitors (real-time) =====
const VISITOR_KEY = "jf_admin_visitor_id";
const visitorId = sessionStorage.getItem(VISITOR_KEY) || ("admin-" + Math.random().toString(36).substring(2,10));
sessionStorage.setItem(VISITOR_KEY, visitorId);

async function trackLiveVisitors() {
  try {
    const res = await fetch(`${backendURL}/api/track-visitor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorId })
    });
    const data = await safeReadJson(res);
    if (data?.success) document.getElementById("visitorCount").innerText = String(data.activeCount ?? "—");
  } catch (err) {
    console.error("Visitor tracking error", err);
  }
}
setInterval(trackLiveVisitors, 5000);

// ==================== EXPIRED CAMPAIGNS ====================
function daysBetween(a, b) {
  const ms = Math.abs((+a) - (+b));
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}
function shortText(s, n=60) {
  const t = String(s || "").trim();
  if (!t) return "—";
  return t.length > n ? (t.slice(0, n) + "…") : t;
}

async function loadExpiredCampaigns() {
  const tbody = document.querySelector("#expiredCampaignsTable tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  try {
    const res = await fetch(`${backendURL}/api/admin/expired-campaigns`, {
      credentials: "include",
      cache: "no-store"
    });
    const data = await safeReadJson(res);
    const rows = Array.isArray(data?.campaigns) ? data.campaigns : [];

    rows.forEach(c => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${c.title || c.Title || "Untitled"}</td>
        <td>${c.Email || c.email || c.creatorEmail || "—"}</td>
        <td>${(c.expiredAt || c.expiresAt) ? new Date(c.expiredAt || c.expiresAt).toLocaleDateString() : "—"}</td>
        <td>${(c.expiredAt || c.expiresAt) ? daysBetween(new Date(), new Date(c.expiredAt || c.expiresAt)) : "—"}</td>
        <td><span class="tag">${c.expiredReviewStatus || "Needs Review"}</span></td>
        <td>${c.expiredOutcome || "—"}</td>
        <td class="small">${shortText(c.expiredReviewNotes || "", 70)}</td>
        <td><button class="action-btn neutral" type="button">Review</button></td>
      `;
      tbody.appendChild(tr);

      tr.querySelector("button").addEventListener("click", () => openExpiredModal(c));
    });

  } catch (err) {
    console.error("loadExpiredCampaigns error:", err);
  }
}

async function loadExpiredCampaignsCount() {
  try {
    const res = await fetch(`${backendURL}/api/admin/expired-campaigns`, {
      credentials: "include",
      cache: "no-store"
    });
    const data = await safeReadJson(res);
    const campaigns = Array.isArray(data?.campaigns) ? data.campaigns : [];
    const el = document.getElementById("expiredCampaignsCount");
    if (el) el.textContent = String(campaigns.length);
  } catch (e) {
    console.error("loadExpiredCampaignsCount error:", e);
    const el = document.getElementById("expiredCampaignsCount");
    if (el) el.textContent = "0";
  }
}

// Modal wiring (Expired)
const expModalBackdrop = document.getElementById("expModalBackdrop");
const expCloseBtn = document.getElementById("expCloseBtn");
const expSaveBtn  = document.getElementById("expSaveBtn");
const expRestoreBtn = document.getElementById("expRestoreBtn");
const expRestoreDays = document.getElementById("expRestoreDays");

let expCurrent = null;

function closeExpiredModal() {
  expModalBackdrop.style.display = "none";
  expModalBackdrop.setAttribute("aria-hidden", "true");
  expCurrent = null;
}
expCloseBtn.addEventListener("click", closeExpiredModal);
expModalBackdrop.addEventListener("click", (e) => {
  if (e.target === expModalBackdrop) closeExpiredModal();


// ==================== CAMPAIGN DETAILS MODAL ====================
const campModalBackdrop = document.getElementById("campModalBackdrop");
const campCloseBtn = document.getElementById("campCloseBtn");


function ensureCampaignModalDom(){
  // If markup exists, just map elements.
  let backdrop = document.getElementById("campaignModalBackdrop");
  if (!backdrop){
    // Safety: create DOM if someone removed markup.
    backdrop = document.createElement("div");
    backdrop.id = "campaignModalBackdrop";
    backdrop.className = "modal-backdrop";
    backdrop.style.display = "none";
    backdrop.setAttribute("aria-hidden","true");
    backdrop.innerHTML = `
      <div id="campaignModal" class="modal" role="dialog" aria-modal="true" aria-labelledby="campaignModalTitle">
        <div class="modal-header">
          <div style="display:flex;flex-direction:column;gap:4px;">
            <h2 id="campaignModalTitle" style="margin:0;font-size:18px;">Campaign Details</h2>
            <div id="campaignModalMeta" style="font-size:12px;opacity:.8;"></div>
          </div>
          <button id="campaignModalClose" class="btn btn-secondary" type="button" aria-label="Close">Close</button>
        </div>
        <div id="campaignModalBody" class="modal-body"></div>
      </div>`;
    document.body.appendChild(backdrop);
  }
  const modal = document.getElementById("campaignModal");
  const body = document.getElementById("campaignModalBody");
  const closeBtn = document.getElementById("campaignModalClose");
  const meta = document.getElementById("campaignModalMeta");

  // Wire close events once
  if (!backdrop.dataset.wired){
    closeBtn?.addEventListener("click", closeCampaignModal);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeCampaignModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCampaignModal(); });
    backdrop.dataset.wired = "1";
  }

  return { backdrop, modal, body, closeBtn, meta };
}


function closeCampaignModal() {
  // Close BOTH possible campaign modals (some versions use campModalBackdrop, others use campaignModalBackdrop)
  const b1 = document.getElementById("campModalBackdrop");
  if (b1) {
    b1.style.display = "none";
    b1.setAttribute("aria-hidden", "true");
  }
  const b2 = document.getElementById("campaignModalBackdrop");
  if (b2) {
    b2.style.display = "none";
    b2.setAttribute("aria-hidden", "true");
  }
}

// Wire up close actions for Campaign Details modal (button, backdrop click, Esc)
(function wireCampaignModalClose(){
  const backdrop = document.getElementById("campModalBackdrop");
  const btn = document.getElementById("campCloseBtn");

  if (btn && !btn.dataset.wired){
    btn.addEventListener("click", closeCampaignModal);
    btn.dataset.wired = "1";
  }

  if (backdrop && !backdrop.dataset.wiredClose){
    // Click outside the modal closes
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeCampaignModal();
    });
    backdrop.dataset.wiredClose = "1";
  }

  if (!window.__campEscWired){
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape"){
        const bd = document.getElementById("campModalBackdrop");
        if (bd && bd.style.display !== "none" && bd.getAttribute("aria-hidden") === "false"){
          closeCampaignModal();
        }
      }
    });
    window.__campEscWired = true;
  }
})();


campCloseBtn?.addEventListener("click", closeCampaignModal);
campModalBackdrop?.addEventListener("click", (e) => {
  if (e.target === campModalBackdrop) closeCampaignModal();
});

function statusTagClass(status) {
  const s = String(status || "").toLowerCase();
  if (s === "pending") return "pending";
  if (s === "approved") return "approved";
  if (s === "denied") return "denied";
  if (s === "active") return "approved";
  if (s === "closed") return "denied";
  return "";
}



function openCampaignModal(c) {
  // Accept either {success, campaign} or the campaign object directly
  const camp = c?.campaign ? c.campaign : c;

  const backdrop = document.getElementById("campModalBackdrop");
  if (!backdrop) return;

  // Elements
  const elTitle = document.getElementById("campTitle");
  const elStatusLine = document.getElementById("campStatusLine");
  const elStatusTag = document.getElementById("campStatusTag");
  const elCreatorName = document.getElementById("campCreatorName");
  const elCreatorEmail = document.getElementById("campCreatorEmail");
  const elCreatedAt = document.getElementById("campCreatedAt");
  const elLocation = document.getElementById("campLocation");
  const elCategory = document.getElementById("campCategory");
  const elGoal = document.getElementById("campGoal");
  const elDesc = document.getElementById("campDescription");
  const elImageWrap = document.getElementById("campImageWrap");
  const elPublicLinkWrap = document.getElementById("campPublicLinkWrap");
  const elIdLine = document.getElementById("campIdLine");

  // Normalize fields
  const id = camp?._id || camp?.id || camp?.Id || "—";
  const title = camp?.title || camp?.Title || "Untitled";
  const status = camp?.status || camp?.Status || "—";
  const email = camp?.email || camp?.Email || camp?.creatorEmail || camp?.CreatorEmail || "—";
  const createdAt = camp?.createdAt || camp?.CreatedAt || camp?.created_at || camp?.created || camp?.dateSubmitted;

  const goal = camp?.goal || camp?.Goal || "—";
  const city = camp?.city || camp?.City || "";
  const state = camp?.state || camp?.State || "";
  const location = [city, state].filter(Boolean).join(", ") || "—";
  const category = camp?.category || camp?.Category || "—";

  const description = camp?.description || camp?.Description || camp?.desc || camp?.Desc || "";
  const imageUrl = camp?.imageUrl || camp?.ImageURL || camp?.ImageUrl || camp?.imageURL || camp?.image || camp?.Image || "";
  const publicUrl = camp?.publicUrl || camp?.PublicUrl || camp?.link || camp?.Link || "";

  // Fill UI
  if (elTitle) elTitle.textContent = title;
  if (elStatusLine) elStatusLine.textContent = `Status: ${status}`;
  if (elStatusTag) {
    elStatusTag.textContent = status;
    elStatusTag.className = `tag ${statusTagClass(status)}`;
  }

  if (elCreatorName) elCreatorName.textContent = "—";
  if (elCreatorEmail) elCreatorEmail.textContent = email;

  if (elCreatedAt) {
    const dt = createdAt ? new Date(createdAt) : null;
    elCreatedAt.textContent = dt && !isNaN(dt) ? `Submitted: ${dt.toLocaleString()}` : "Submitted: —";
  }

  if (elLocation) elLocation.textContent = location;
  if (elCategory) elCategory.textContent = category;
  if (elGoal) elGoal.textContent = `Goal: $${goal}`;

  if (elDesc) elDesc.textContent = description || "—";

  if (elImageWrap) {
    if (imageUrl) {
      elImageWrap.innerHTML = `
        <img src="${escapeAttr(imageUrl)}" alt="Campaign image" style="width:100%;max-width:520px;border-radius:14px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.04);" />
        <div style="margin-top:8px;opacity:.8;word-break:break-word;">${escapeHtml(imageUrl)}</div>
      `;
    } else {
      elImageWrap.textContent = "—";
    }
  }

  if (elPublicLinkWrap) {
    if (publicUrl) {
      elPublicLinkWrap.innerHTML = `Public link: <a href="${escapeAttr(publicUrl)}" target="_blank" rel="noopener">Open</a>`;
    } else {
      elPublicLinkWrap.textContent = "—";
    }
  }

  if (elIdLine) elIdLine.textContent = `ID: ${id}`;

  // Show
  backdrop.style.display = "flex";
  backdrop.setAttribute("aria-hidden", "false");
}

/** Close helpers for Campaign Details modal */
function closeCampaignModal() {
  const backdrop = document.getElementById("campModalBackdrop");
  if (!backdrop) return;
  backdrop.style.display = "none";
  backdrop.setAttribute("aria-hidden", "true");
}

// Wire close actions (button, click outside, ESC)
(function wireCampaignModalClose() {
  const backdrop = document.getElementById("campModalBackdrop");
  const closeBtn = document.getElementById("campCloseBtn");
  if (closeBtn) closeBtn.addEventListener("click", closeCampaignModal);

  if (backdrop) {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeCampaignModal();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const bd = document.getElementById("campModalBackdrop");
      if (bd && bd.style.display !== "none") closeCampaignModal();
    }
  });
})();


// Escape helpers to avoid breaking the modal if someone enters HTML
function escapeHtml(str){
  return String(str ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}
function escapeAttr(str){ return escapeHtml(str); }

});

function openExpiredModal(c) {
  expCurrent = c;
  expModalBackdrop.style.display = "flex";
  expModalBackdrop.setAttribute("aria-hidden", "false");

  const title = c.title || c.Title || "Untitled";
  const email = c.Email || c.email || c.creatorEmail || "—";

  const expiredAt = c.expiredAt ? new Date(c.expiredAt) : null;
  const expiresAt = c.expiresAt ? new Date(c.expiresAt) : null;

  document.getElementById("expTitle").innerText = title;
  document.getElementById("expEmail").innerText = email;
  document.getElementById("expDates").innerText =
    `expiresAt: ${expiresAt ? expiresAt.toLocaleString() : "—"} • expiredAt: ${expiredAt ? expiredAt.toLocaleString() : "—"}`;

  document.getElementById("expReviewStatus").value = c.expiredReviewStatus || "Needs Review";
  document.getElementById("expOutcome").value = c.expiredOutcome || "";
  document.getElementById("expNotes").value = c.expiredReviewNotes || "";
}

async function saveExpiredReview(campaignId, payload) {
  const res = await fetch(`${backendURL}/api/admin/campaigns/${encodeURIComponent(campaignId)}/expired-review`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await safeReadJson(res);
  if (!res.ok) throw new Error(data?.message || "Failed to save review");
  return data;
}

async function restoreExpiredCampaign(campaignId, days, note) {
  const res = await fetch(`${backendURL}/api/admin/campaigns/${encodeURIComponent(campaignId)}/restore`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ days, note })
  });
  const data = await safeReadJson(res);
  if (!res.ok) throw new Error(data?.message || "Restore failed");
  return data;
}

expSaveBtn.addEventListener("click", async () => {
  if (!expCurrent) return;

  const id = expCurrent._id || expCurrent.Id || expCurrent.id;
  const expiredReviewStatus = document.getElementById("expReviewStatus").value.trim();
  const expiredOutcome = document.getElementById("expOutcome").value.trim();
  const expiredReviewNotes = document.getElementById("expNotes").value;

  try {
    expSaveBtn.disabled = true;
    await saveExpiredReview(id, { expiredReviewStatus, expiredOutcome, expiredReviewNotes });
    closeExpiredModal();
    await loadExpiredCampaigns();
  } catch (e) {
    alert(e.message || "Save failed");
  } finally {
    expSaveBtn.disabled = false;
  }
});

expRestoreBtn.addEventListener("click", async () => {
  if (!expCurrent) return;

  const days = Number(expRestoreDays.value);
  if (!days) {
    alert("Please choose how many days to restore the campaign for.");
    return;
  }

  const id = expCurrent._id || expCurrent.Id || expCurrent.id;
  const note = document.getElementById("expNotes").value.trim();

  try {
    expRestoreBtn.disabled = true;
    await restoreExpiredCampaign(id, days, note);
    alert(`Campaign restored for ${days} days.`);
    closeExpiredModal();
    await loadExpiredCampaigns();
    await loadExpiredCampaignsCount();
  } catch (e) {
    alert(e.message || "Restore failed");
  } finally {
    expRestoreBtn.disabled = false;
  }
});

document.getElementById("viewExpiredBtn")?.addEventListener("click", async () => {
  document.getElementById("nav-campaigns")?.click();
  await loadExpiredCampaigns();
  document.getElementById("expiredCampaignsTable")?.scrollIntoView({ behavior: "smooth", block: "start" });
});


// ===== Campaign "View" popup (robust) =====
function openCampaignModal(data) {
  const camp = data?.campaign ? data.campaign : data;

  // Prefer the simple modal appended at bottom of the HTML (IDs below)
  const backdrop = document.getElementById("campaignModalBackdrop") || document.getElementById("campModalBackdrop");
  if (!backdrop) return;

  // If we're using the simple modal (campaignModalBackdrop)
  const titleEl = document.getElementById("campaignModalTitle");
  const metaEl = document.getElementById("campaignModalMeta");
  const bodyEl = document.getElementById("campaignModalBody");

  // Normalize fields (support many key names)
  const id = camp?._id || camp?.id || camp?.Id || "—";
  const title = camp?.title || camp?.Title || "Untitled";
  const email = camp?.email || camp?.Email || camp?.creatorEmail || camp?.CreatorEmail || "—";
  const goal = camp?.goal || camp?.Goal || "—";
  const status = camp?.status || camp?.Status || "—";
  const createdAtRaw = camp?.createdAt || camp?.CreatedAt || camp?.created_at || camp?.created || camp?.dateSubmitted;
  const createdAt = createdAtRaw ? new Date(createdAtRaw).toLocaleString() : "—";

  const city = camp?.city || camp?.City || "—";
  const state = camp?.state || camp?.State || "—";

  const desc = camp?.description || camp?.Description || camp?.desc || camp?.Desc || "";
  const description = String(desc || "").trim() || "—";

  const imageUrl =
    camp?.imageUrl ||
    camp?.ImageURL ||
    camp?.image ||
    camp?.Image ||
    camp?.photoUrl ||
    camp?.PhotoUrl ||
    "";

  // If the rich modal (campModalBackdrop) exists, try to populate it too (best effort)
  const richBackdrop = document.getElementById("campModalBackdrop");
  if (richBackdrop && backdrop === richBackdrop) {
    try {
      document.getElementById("campTitle").innerText = title;
      document.getElementById("campCreatorEmail").innerText = email;
      document.getElementById("campCreatedAt").innerText = createdAt;
      document.getElementById("campGoal").innerText = `Goal: $${goal}`;
      document.getElementById("campCategory").innerText = camp?.category || camp?.Category || "—";
      document.getElementById("campLocation").innerText = `${city}${city !== "—" && state !== "—" ? ", " : ""}${state}`;
      document.getElementById("campDescription").innerText = description;

      const wrap = document.getElementById("campImageWrap");
      if (wrap) {
        wrap.innerHTML = imageUrl
          ? `<img src="${escapeHtml(imageUrl)}" alt="Campaign Image" style="max-width:100%;border-radius:12px;border:1px solid #e5e5e5;" />`
          : "—";
      }
      const idLine = document.getElementById("campIdLine");
      if (idLine) idLine.innerText = `ID: ${id}`;
    } catch (e) {
      // fall back to simple modal below
    }
    richBackdrop.style.display = "flex";
    richBackdrop.setAttribute("aria-hidden", "false");
    return;
  }

  // Simple modal rendering
  if (titleEl) titleEl.textContent = title;
  if (metaEl) metaEl.textContent = `Submitted: ${createdAt} • Status: ${status} • Creator: ${email}`;

  if (bodyEl) {
    bodyEl.innerHTML = `
      <div style="display:grid;grid-template-columns:1.1fr .9fr;gap:14px;">
        <div>
          <div style="display:grid;grid-template-columns:140px 1fr;gap:8px 12px;font-size:14px;">
            <div style="opacity:.7;">Goal</div><div><b>$${escapeHtml(goal)}</b></div>
            <div style="opacity:.7;">City</div><div>${escapeHtml(city)}</div>
            <div style="opacity:.7;">State</div><div>${escapeHtml(state)}</div>
            <div style="opacity:.7;">Campaign ID</div><div class="mono">${escapeHtml(id)}</div>
          </div>

          <div style="margin-top:14px;padding:12px;border-radius:12px;border:1px solid #e5e5e5;background:#fafafa;">
            <div style="font-weight:800;margin-bottom:6px;">Description</div>
            <div style="white-space:pre-wrap;line-height:1.35;">${escapeHtml(description)}</div>
          </div>
        </div>

        <div>
          <div style="font-weight:800;margin-bottom:8px;">Image</div>
          ${
            imageUrl
              ? `<img src="${escapeHtml(imageUrl)}" alt="Campaign Image" style="width:100%;border-radius:12px;border:1px solid #e5e5e5;" />`
              : `<div style="padding:12px;border-radius:12px;border:1px dashed #ccc;color:#666;">No image found for this campaign.</div>`
          }
        </div>
      </div>
    `;
  }

  backdrop.style.display = "flex";
  backdrop.setAttribute("aria-hidden", "false");
}

function closeCampaignModal() {
  const backdrops = [
    document.getElementById("campaignModalBackdrop"),
    document.getElementById("campModalBackdrop")
  ].filter(Boolean);

  backdrops.forEach((bd) => {
    bd.style.display = "none";
    bd.setAttribute("aria-hidden", "true");
  });
}

// Wire the close buttons (both modal variants)
document.getElementById("campaignModalClose")?.addEventListener("click", closeCampaignModal);
document.getElementById("campCloseBtn")?.addEventListener("click", closeCampaignModal);

// Close on backdrop click (optional)
document.getElementById("campaignModalBackdrop")?.addEventListener("click", (e) => {
  if (e.target?.id === "campaignModalBackdrop") closeCampaignModal();
});
document.getElementById("campModalBackdrop")?.addEventListener("click", (e) => {
  if (e.target?.id === "campModalBackdrop") closeCampaignModal();
});

// Expose modal helpers
window.openCampaignModal = openCampaignModal;
window.closeCampaignModal = closeCampaignModal;

// ==================== REFRESH ====================
async function refreshDashboard() {
  try {
    await Promise.all([
      loadCampaigns(),
      loadDonations(),
      loadAdminStats(),
      loadJoyBoostCount(),
      loadExpiredCampaignsCount(),
      loadPendingIdCount(),
      loadApprovedIdCount()
    ]);
  } catch (err) {
    console.error("refreshDashboard error:", err);
  }
  document.getElementById("lastRefresh").innerText = new Date().toLocaleTimeString();
}

document.getElementById("refreshBtn").addEventListener("click", refreshDashboard);

// ✅ Init
(async function initAdminPage(){
  const ok = await checkAdminSession();
  if (!ok) return;
  await refreshDashboard();
  trackLiveVisitors();
})();
</script>

<!-- Campaign Details Modal -->
<div id="campaignModalBackdrop" class="modal-backdrop" aria-hidden="true" style="display:none;">
  <div id="campaignModal" class="modal" role="dialog" aria-modal="true" aria-labelledby="campaignModalTitle">
    <div class="modal-header">
      <div style="display:flex;flex-direction:column;gap:4px;">
        <h2 id="campaignModalTitle" style="margin:0;font-size:18px;">Campaign Details</h2>
        <div id="campaignModalMeta" style="font-size:12px;opacity:.8;"></div>
      </div>
      <button id="campaignModalClose" class="btn btn-secondary" type="button" aria-label="Close">Close</button>
    </div>
    <div id="campaignModalBody" class="modal-body"></div>
  </div>
</div>
<script>
  function closeCampaignModal() {
    const ids = ["campModalBackdrop", "campaignModalBackdrop"];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    });
  }

  document.addEventListener("click", function (e) {
    if (e.target.id === "campModalBackdrop" || e.target.id === "campaignModalBackdrop") {
      closeCampaignModal();
    }
    if (e.target.id === "campCloseBtn") {
      closeCampaignModal();
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeCampaignModal();
  });

  // make modal content scrollable so long text is visible
  const style = document.createElement("style");
  style.innerHTML = `
    #campModalBackdrop .modal,
    #campaignModalBackdrop .modal {
      max-height: 90vh;
      overflow: hidden;
    }
    #campModalBackdrop .modal-body,
    #campaignModalBackdrop .modal-body {
      max-height: 70vh;
      overflow-y: auto;
    }
  `;
  document.head.appendChild(style);
</script>

<script>
async function loadSettings(){
  const res = await fetch(backendURL + "/api/admin/settings",{credentials:"include"});
  const data = await res.json();
  const s = data.settings || {};
  document.getElementById("toggleDemoMode").checked = !!s.demoMode;
  document.getElementById("toggleVisitorLogging").checked = !!s.visitorLogging;
  document.getElementById("toggleProfanityFilter").checked = !!s.profanityFilter;
  document.getElementById("toggleCampaignApproval").checked = !!s.requireCampaignApproval;
  document.getElementById("toggleAutoDonationEmail").checked = !!s.autoDonationEmail;
  document.getElementById("toggleUserRegistration").checked = !!s.allowUserRegistration;
  document.getElementById("toggleVolunteerApplications").checked = !!s.acceptVolunteerApplications;
  document.getElementById("toggleCampaignVisibility").checked = !!s.publicCampaignVisibility;
  document.getElementById("toggleEmailNotifications").checked = !!s.emailNotifications;
}

async function saveSettings(){
  const body = {
    demoMode: document.getElementById("toggleDemoMode").checked,
    visitorLogging: document.getElementById("toggleVisitorLogging").checked,
    profanityFilter: document.getElementById("toggleProfanityFilter").checked,
    requireCampaignApproval: document.getElementById("toggleCampaignApproval").checked,
    autoDonationEmail: document.getElementById("toggleAutoDonationEmail").checked,
    allowUserRegistration: document.getElementById("toggleUserRegistration").checked,
    acceptVolunteerApplications: document.getElementById("toggleVolunteerApplications").checked,
    publicCampaignVisibility: document.getElementById("toggleCampaignVisibility").checked,
    emailNotifications: document.getElementById("toggleEmailNotifications").checked
  };
  await fetch(backendURL + "/api/admin/settings",{
    method:"PUT",
    credentials:"include",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify(body)
  });
}

document.querySelectorAll("#settingsSection input[type=checkbox]").forEach(cb=>{
  cb.addEventListener("change", saveSettings);
});

window.addEventListener("DOMContentLoaded", loadSettings);
</script>

</body>
</html>
