const Campaign = require("./Campaign"); // your Campaign model
const User = require("./User");         // your User model
const sendMailjet = require("./sendMailjet"); // your email function
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // e.g., https://your-site.com

/**
 * Checks if a campaign reached its goal and sends ID verification email
 * @param {String} campaignId - The ID of the campaign
 */
async function checkCampaignGoal(campaignId) {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) return;

  // Only continue if goal reached AND ID not yet verified
  if (campaign.currentAmount >= campaign.goalAmount && !campaign.idVerified) {
    const creator = await User.findById(campaign.creatorId);
    if (!creator) return;

    const dashboardUrl = `${PUBLIC_BASE_URL}/dashboard.html`;

    // Send email to creator
    await sendMailjet({
      toEmail: creator.email,
      toName: creator.name || "",
      subject: "ID verification now available for your campaign",
      text: `Congratulations! Your campaign "${campaign.title}" has reached its goal.

Please verify your ID via your dashboard to unlock campaign rewards:
${dashboardUrl}

— JoyFund`,
      html: `
        <p>Congratulations! Your campaign "<strong>${campaign.title}</strong>" has reached its goal.</p>
        <p>Please verify your ID via your dashboard to unlock campaign rewards.</p>
        <p><a href="${dashboardUrl}">Go to Dashboard</a></p>
      `
    });

    console.log(`📧 ID verification email sent to ${creator.email}`);
  }
}

module.exports = { checkCampaignGoal };