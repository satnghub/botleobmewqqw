Facebook Messenger Digital Shop Bot (v3.0.0 - Web Config & Unique Stock)
A Facebook Messenger bot for selling digital goods with enhanced features:

Unique Item Stock: Each product holds a list of unique items (codes, links). Purchase consumes one specific item.
Web-Based Configuration: Set Tokens, Wallet/Bank details, API keys via the admin panel (/admin/settings).
TrueMoney Wallet Angpao (Automatic Redemption)
Bank Transfer (via Xncly Slip Verification API with duplicate check)
Code Redemption (User provides a 32-character code)
Admin Dashboard (/admin) for managing:
Products (with unique item list input)
Categories
Orders (viewing delivered items)
Redemption Codes
System Settings
Security Warning
🚨 This code DOES NOT include admin authentication. Anyone accessing /admin can view/change sensitive data. Add security (password, login) before public deployment! 🚨

Setup
Install Dependencies: npm install
Run Once: node index.js. This will create initial config.json, shop_data.json, etc.
Initial Configuration: Stop the bot (Ctrl+C). Either:
Edit the created config.json file directly.
Restart the bot (npm start) and immediately go to /admin/settings in your browser to configure everything.
SSL (Recommended):
Get SSL certificates (e.g., Let's Encrypt).
Update the SSL_PRIVATE_KEY_PATH and SSL_CERTIFICATE_PATH in config.json or the Admin Settings page.
Restart the bot. It will use HTTPS if certificates are found.
Facebook App Setup:
Create/Use a Facebook App.
Set up Messenger Platform.
Add a Webhook pointing to your bot's URL + /webhook (e.g., https://yourdomain.com/webhook).
Use the VERIFY_TOKEN from your bot's config/settings page.
Subscribe to messages, messaging_postbacks.
Add the PAGE_ACCESS_TOKEN from Facebook App to your bot's config/settings.
Run: npm start
Key Changes in v3
Products use availableItems array (list of unique strings) instead of stock number and single downloadUrl.
Admin panel modified for managing availableItems.
Configuration moved from hardcoded constants to config.json and the /admin/settings page.
Backup
Regularly back up config.json, shop_data.json, verified_slips.json, redemption_codes.json.
