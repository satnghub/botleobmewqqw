
const express = require('express');
const bodyParser = require('body-parser');
const request = require('request'); // Still used for simpler Facebook API calls
const fs = require('fs');
const path = require('path');
const FormData = require('form-data'); // Needed for slip upload
const https = require('https');
const http = require('http'); // Needed for HTTP server option
const { Writable } = require('stream'); // Needed for downloading image to buffer
const axios = require('axios'); // For Xncly Slip Check API, FB connection check, and Angpao Redeem
const crypto = require('crypto'); // For code generation/hashing

// --- File Paths ---
const DATA_DIR = __dirname; // Store data in the same directory as the script
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DATA_FILE = path.join(DATA_DIR, 'shop_data.json');
const VERIFIED_SLIPS_FILE = path.join(DATA_DIR, 'verified_slips.json');
const REDEMPTION_CODES_FILE = path.join(DATA_DIR, 'redemption_codes.json');
const DISCOUNT_CODES_FILE = path.join(DATA_DIR, 'discount_codes.json');

// --- Default Configuration (used if config.json is missing/invalid) ---
const DEFAULT_CONFIG = {
    // FB Messenger
    fbVerifyToken: 'replace_this_in_admin_settings', // Replace with a random strong string
    fbPageAccessToken: '',
    adminContactLink: 'https://m.me/YOUR_PAGE_ID_HERE', // Replace with your page's message link
    welcomeGif: 'https://i.pinimg.com/originals/fe/f4/1f/fef41f9945b81122f30e216d02efd0a7.gif',
    // Wallet (Angpao - Phone used for REDEEMING)
    walletPhone: '', // **Required** for the bot to REDEEM angpao links
    walletImage: 'https://res09.bignox.com/appcenter/th/2020/05/TrueMoney.jpg',
    // Bank Transfer
    bankAccountDetails: "ธนาคาร: กรอกใน Admin\nเลขบัญชี: กรอกใน Admin\nชื่อบัญชี: กรอกใน Admin",
    bankImage: 'https://i.pinimg.com/474x/c8/7a/a5/c87aa5a2adc0ac60659100f3e880aa41.jpg',
    // Xncly API
    xnclyClientIdSecret: '', // Format: CLIENTID:SECRET
    xnclyCheckUrl: 'https://ccd.xncly.xyz/api/check-slip',
    // Codes & Discounts Images
    codeRedemptionImage: 'https://cdn-icons-png.flaticon.com/512/1087/1087815.png',
    discountImage: 'https://cdn-icons-png.flaticon.com/512/2438/2438112.png',
    // Auto Promotion
    autoPromotionEnabled: false,
    autoPromotionPercentage: 10, // Default 10%
    autoPromotionMinPurchase: 500, // Default 500 THB minimum
    // Server & Connection Settings
    serverPort: 3000, // Default port (will use 8443 if HTTPS detected initially)
    enableHttps: false,
    sslKeyPath: '/etc/letsencrypt/live/YOUR_DOMAIN/privkey.pem', // Default placeholder path
    sslCertPath: '/etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem' // Default placeholder path
};

// --- Global Variables ---
let loadedConfig = { ...DEFAULT_CONFIG }; // Start with defaults
let shopData = {};
let verifiedSlips = []; // Stores verified 'transRef' IDs
let validRedemptionCodes = [];
let discountCodes = [];
let serverInstance = null; // To hold the HTTP/HTTPS server instance

// --- Configuration Loading/Saving ---
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const fileContent = fs.readFileSync(CONFIG_FILE, 'utf8');
            const parsedConfig = JSON.parse(fileContent);
            // Merge ensuring new default keys are added if missing in saved config
            loadedConfig = { ...DEFAULT_CONFIG, ...parsedConfig };
            console.log("Configuration loaded successfully from config.json.");
        } else {
            console.warn("config.json not found. Using default values. Please configure settings via /admin/settings.");
            // Detect if default certs likely exist to guess initial HTTPS state
            try {
                fs.accessSync(DEFAULT_CONFIG.sslKeyPath, fs.constants.R_OK);
                fs.accessSync(DEFAULT_CONFIG.sslCertPath, fs.constants.R_OK);
                console.log("Default SSL certificate paths seem accessible, enabling HTTPS by default.");
                loadedConfig.enableHttps = true;
                loadedConfig.serverPort = 8443; // Default HTTPS port
            } catch (err) {
                console.log("Default SSL certificates not found or accessible, using HTTP by default.");
                loadedConfig.enableHttps = false;
                loadedConfig.serverPort = 3000; // Default HTTP port
            }
            saveConfig(); // Create the file with determined default values
        }
        // Ensure correct types after loading
        loadedConfig.autoPromotionEnabled = loadedConfig.autoPromotionEnabled === true;
        loadedConfig.autoPromotionPercentage = parseFloat(loadedConfig.autoPromotionPercentage) || 0;
        loadedConfig.autoPromotionMinPurchase = parseFloat(loadedConfig.autoPromotionMinPurchase) || 0;
        loadedConfig.serverPort = parseInt(loadedConfig.serverPort, 10) || DEFAULT_CONFIG.serverPort;
        loadedConfig.enableHttps = loadedConfig.enableHttps === true;
        loadedConfig.sslKeyPath = loadedConfig.sslKeyPath || DEFAULT_CONFIG.sslKeyPath;
        loadedConfig.sslCertPath = loadedConfig.sslCertPath || DEFAULT_CONFIG.sslCertPath;
        loadedConfig.walletPhone = String(loadedConfig.walletPhone || '').trim(); // Ensure wallet phone is string

    } catch (error) {
        console.error(`Error loading config.json: ${error.message}. Using default values.`);
        loadedConfig = { ...DEFAULT_CONFIG }; // Reset to defaults on error
    }
}

function saveConfig() {
    try {
        // Ensure boolean/numbers/strings are saved correctly
        loadedConfig.autoPromotionEnabled = loadedConfig.autoPromotionEnabled === true;
        loadedConfig.autoPromotionPercentage = parseFloat(loadedConfig.autoPromotionPercentage) || 0;
        loadedConfig.autoPromotionMinPurchase = parseFloat(loadedConfig.autoPromotionMinPurchase) || 0;
        loadedConfig.serverPort = parseInt(loadedConfig.serverPort, 10) || DEFAULT_CONFIG.serverPort;
        loadedConfig.enableHttps = loadedConfig.enableHttps === true;
        loadedConfig.walletPhone = String(loadedConfig.walletPhone || '').trim();

        fs.writeFileSync(CONFIG_FILE, JSON.stringify(loadedConfig, null, 2), 'utf8');
        console.log("Configuration saved to config.json.");
    } catch (error) {
        console.error("Error saving configuration to config.json:", error);
    }
}

// --- Initial Load ---
loadConfig(); // Load configuration first

// --- Load or initialize shop data ---
try {
    if (fs.existsSync(DATA_FILE)) {
        shopData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (!shopData) shopData = {};
        if (!Array.isArray(shopData.categories)) shopData.categories = [];
        shopData.categories = shopData.categories.map(category =>
            typeof category === 'string' ? { name: category, imageUrl: '', description: '' } : { name: category.name || 'Unnamed', imageUrl: category.imageUrl || '', description: category.description || '' }
        );
        if (!Array.isArray(shopData.products)) shopData.products = [];
        shopData.products = shopData.products.map(p => ({
            ...p,
            stockItems: Array.isArray(p.stockItems) ? p.stockItems : [], // Ensure stockItems is array
            stock: Array.isArray(p.stockItems) ? p.stockItems.length : 0,
            createdAt: p.createdAt || new Date(0).toISOString(), // Ensure createdAt exists
            updatedAt: p.updatedAt || new Date(0).toISOString() // Ensure updatedAt exists
        }));
        if (typeof shopData.users !== 'object' || shopData.users === null) shopData.users = {};
        if (!Array.isArray(shopData.orders)) shopData.orders = [];
         // Add createdAt/updatedAt if missing in orders
         shopData.orders = shopData.orders.map(o => ({
            ...o,
            createdAt: o.createdAt || new Date(0).toISOString(),
            updatedAt: o.updatedAt || new Date(0).toISOString(),
         }));

    } else {
        throw new Error("Shop data file not found, creating new one.");
    }
} catch (error) {
    console.warn(`Warning: ${error.message}. Initializing shop data.`);
    shopData = { products: [], categories: [], users: {}, orders: [] };
    saveShopData();
}

// --- Load or initialize verified slips data ---
try {
    if (fs.existsSync(VERIFIED_SLIPS_FILE)) {
        verifiedSlips = JSON.parse(fs.readFileSync(VERIFIED_SLIPS_FILE, 'utf8'));
        if (!Array.isArray(verifiedSlips)) {
            verifiedSlips = [];
            saveVerifiedSlips();
        }
        console.log(`Loaded ${verifiedSlips.length} verified slip references (transRef).`);
    } else {
        verifiedSlips = [];
        saveVerifiedSlips();
    }
} catch (error) {
    console.error(`Error loading verified slips: ${error.message}. Initializing empty list.`);
    verifiedSlips = [];
    saveVerifiedSlips();
}

// --- Load or initialize valid redemption codes data ---
try {
    if (fs.existsSync(REDEMPTION_CODES_FILE)) {
        validRedemptionCodes = JSON.parse(fs.readFileSync(REDEMPTION_CODES_FILE, 'utf8'));
        if (!Array.isArray(validRedemptionCodes)) {
            validRedemptionCodes = [];
            saveValidRedemptionCodes();
        }
        console.log(`Loaded ${validRedemptionCodes.length} valid redemption codes.`);
    } else {
        validRedemptionCodes = [];
        saveValidRedemptionCodes();
    }
} catch (error) {
    console.error(`Error loading redemption codes: ${error.message}. Initializing empty list.`);
    validRedemptionCodes = [];
    saveValidRedemptionCodes();
}

// --- Load or initialize discount codes data ---
function loadDiscountCodes() {
    try {
        if (fs.existsSync(DISCOUNT_CODES_FILE)) {
            discountCodes = JSON.parse(fs.readFileSync(DISCOUNT_CODES_FILE, 'utf8'));
            if (!Array.isArray(discountCodes)) {
                discountCodes = [];
                saveDiscountCodes();
            }
            // Ensure essential fields exist (add defaults if needed)
            discountCodes = discountCodes.map(code => ({
                ...code,
                id: code.id || `DC-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
                code: code.code || '',
                type: code.type || 'percentage', // Default to percentage
                value: code.value || 0,
                maxUses: code.maxUses === null || code.maxUses === Infinity ? null : (parseInt(code.maxUses, 10) || null), // Allow null/Infinity
                uses: parseInt(code.uses, 10) || 0,
                minPurchase: parseFloat(code.minPurchase) || 0,
                expiresAt: code.expiresAt || null, // Should be ISO string or null
                createdAt: code.createdAt || new Date().toISOString()
            }));
            console.log(`Loaded ${discountCodes.length} discount codes.`);
        } else {
            discountCodes = [];
            saveDiscountCodes();
            console.log("Created empty discount_codes.json file.");
        }
    } catch (error) {
        console.error(`Error loading discount codes: ${error.message}. Initializing empty list.`);
        discountCodes = [];
        saveDiscountCodes();
    }
}
loadDiscountCodes(); // Load discounts on startup

// --- Save Data Functions ---
function saveShopData() {
    try {
        // Update stock count just before saving for ALL products
        shopData.products.forEach(p => {
            p.stock = Array.isArray(p.stockItems) ? p.stockItems.length : 0;
        });
        fs.writeFileSync(DATA_FILE, JSON.stringify(shopData, null, 2), 'utf8');
    } catch (error) {
        console.error("Error saving shop data:", error);
    }
}
function saveVerifiedSlips() {
    try {
        fs.writeFileSync(VERIFIED_SLIPS_FILE, JSON.stringify(verifiedSlips, null, 2), 'utf8');
    } catch (error) {
        console.error("Error saving verified slips:", error);
    }
}
function saveValidRedemptionCodes() {
    try {
        fs.writeFileSync(REDEMPTION_CODES_FILE, JSON.stringify(validRedemptionCodes, null, 2), 'utf8');
    } catch (error) {
        console.error("Error saving redemption codes:", error);
    }
}
function saveDiscountCodes() {
    try {
        fs.writeFileSync(DISCOUNT_CODES_FILE, JSON.stringify(discountCodes, null, 2), 'utf8');
    } catch (error) {
        console.error("Error saving discount codes:", error);
    }
}

// --- Express App Setup ---
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- Facebook Messenger API Functions ---
async function sendApiRequest(options) {
    if (!options.qs || !options.qs.access_token) {
        options.qs = { ...options.qs, access_token: loadedConfig.fbPageAccessToken };
    }
    if (!loadedConfig.fbPageAccessToken) {
        console.error("API Request Error: Facebook Page Access Token is not configured in /admin/settings.");
        return Promise.reject(new Error("Missing Page Access Token"));
    }

    return new Promise((resolve, reject) => {
        request(options, (error, response, body) => {
            if (error) {
                console.error(`API Request Error (${options.url}):`, error);
                reject(error);
            } else if (body && body.error) {
                if (body.error.code === 100 && (body.error.error_subcode === 2018278 || body.error.error_subcode === 2018001 || body.error.error_subcode === 2018108)) {
                    console.log(`User ${options.json?.recipient?.id || '?'} may have blocked the page or messaging is restricted. Error: ${body.error.message}`);
                    resolve({ error: 'USER_BLOCKED_OR_RESTRICTED', details: body.error });
                } else {
                    console.error(`API Request Facebook Error (${options.url}):`, JSON.stringify(body.error));
                    if (body.error.type === 'OAuthException') {
                        console.error("----> Suggestion: Check if the Page Access Token in /admin/settings is correct and valid. <----");
                    }
                    reject(body.error);
                }
            } else if (response.statusCode >= 400) {
                console.error(`API Request HTTP Error (${options.url}): Status ${response.statusCode}`, body);
                reject(new Error(`HTTP Error ${response.statusCode}`));
            } else {
                resolve(body);
            }
        });
    });
}
async function sendTypingIndicator(sender, action = 'typing_on') {
    const options = {
        url: 'https://graph.facebook.com/v19.0/me/messages',
        method: 'POST',
        json: {
            recipient: { id: sender },
            sender_action: action
        }
    };
    try {
        await sendApiRequest(options);
    } catch (error) {
        if (error?.error !== 'USER_BLOCKED_OR_RESTRICTED') {
           console.warn(`Could not send typing indicator to ${sender}: ${error.message || JSON.stringify(error)}`);
        }
    }
}
async function sendMessage(sender, text) {
    if (!sender || !text) return;
    try {
        await sendTypingIndicator(sender, 'typing_on');
        const options = {
            url: 'https://graph.facebook.com/v19.0/me/messages',
            method: 'POST',
            json: { recipient: { id: sender }, message: { text: text } }
        };
        await sendApiRequest(options);
    } catch (error) {
        if (error?.error !== 'USER_BLOCKED_OR_RESTRICTED') {
            console.error(`Error sending text message to ${sender}:`, error.message || JSON.stringify(error));
        }
    } finally {
        await sendTypingIndicator(sender, 'typing_off');
    }
}
async function sendImageMessage(sender, imageUrl) {
    if (!sender || !imageUrl) return;
    try {
        await sendTypingIndicator(sender, 'typing_on');
        const options = {
            url: 'https://graph.facebook.com/v19.0/me/messages',
            method: 'POST',
            json: {
                recipient: { id: sender },
                message: { attachment: { type: "image", payload: { url: imageUrl, is_reusable: true } } }
            }
        };
        await sendApiRequest(options);
    } catch (error) {
        if (error?.error !== 'USER_BLOCKED_OR_RESTRICTED') {
            console.error(`Error sending image message to ${sender}:`, error.message || JSON.stringify(error));
        }
    } finally {
        await sendTypingIndicator(sender, 'typing_off');
    }
}
async function sendGenericTemplate(sender, elements) {
    if (!sender || !elements || !Array.isArray(elements) || elements.length === 0) return;
    try {
        await sendTypingIndicator(sender, 'typing_on');
        const options = {
            url: 'https://graph.facebook.com/v19.0/me/messages',
            method: 'POST',
            json: {
                recipient: { id: sender },
                message: { attachment: { type: "template", payload: { template_type: "generic", elements: elements.slice(0, 10) } } }
            }
        };
        await sendApiRequest(options);
    } catch (error) {
        if (error?.error !== 'USER_BLOCKED_OR_RESTRICTED') {
            console.error(`Error sending generic template to ${sender}:`, error.message || JSON.stringify(error));
        }
    } finally {
        await sendTypingIndicator(sender, 'typing_off');
    }
}
async function sendButtonTemplate(sender, text, buttons) {
    if (!sender || !text || !buttons || !Array.isArray(buttons) || buttons.length === 0) return;
    try {
        await sendTypingIndicator(sender, 'typing_on');
        const options = {
            url: 'https://graph.facebook.com/v19.0/me/messages',
            method: 'POST',
            json: {
                recipient: { id: sender },
                message: { attachment: { type: "template", payload: { template_type: "button", text: text, buttons: buttons.slice(0, 3) } } }
            }
        };
        await sendApiRequest(options);
    } catch (error) {
        if (error?.error !== 'USER_BLOCKED_OR_RESTRICTED') {
            console.error(`Error sending button template to ${sender}:`, error.message || JSON.stringify(error));
        }
    } finally {
        await sendTypingIndicator(sender, 'typing_off');
    }
}
async function sendQuickReplies(sender, text, quickReplies) {
    if (!sender || !text || !quickReplies || !Array.isArray(quickReplies) || quickReplies.length === 0) return;
    try {
        await sendTypingIndicator(sender, 'typing_on');
        const options = {
            url: 'https://graph.facebook.com/v19.0/me/messages',
            method: 'POST',
            json: {
                recipient: { id: sender },
                message: { text: text, quick_replies: quickReplies.slice(0, 13) }
            }
        };
        await sendApiRequest(options);
    } catch (error) {
        if (error?.error !== 'USER_BLOCKED_OR_RESTRICTED') {
            console.error(`Error sending quick replies to ${sender}:`, error.message || JSON.stringify(error));
        }
    } finally {
        await sendTypingIndicator(sender, 'typing_off');
    }
}
// --- End Facebook API Functions ---

// --- Shop Logic Functions ---
function getUserData(sender) {
    if (!shopData.users[sender]) {
        shopData.users[sender] = { cart: [], lastCategory: null, lastViewedProducts: [], currentPage: 0, checkoutState: null };
        saveShopData();
    }
    if (shopData.users[sender].checkoutState === undefined) {
        shopData.users[sender].checkoutState = null;
    }
     if (!Array.isArray(shopData.users[sender].cart)) {
         shopData.users[sender].cart = [];
     }
    return shopData.users[sender];
}
async function showCategories(sender) {
    try {
        if (shopData.categories.length === 0) {
            await sendMessage(sender, "ขออภัย ขณะนี้ยังไม่มีหมวดหมู่สินค้า (กรุณาเพิ่มใน /admin/categories)");
            return;
        }
        await sendImageMessage(sender, loadedConfig.welcomeGif);
        await sendMessage(sender, "สวัสดีครับ! ยินดีต้อนรับสู่ร้าน\nเลือกหมวดหมู่ที่คุณสนใจได้เลยครับ 👇");

        const elements = shopData.categories.map(category => ({
            title: category.name,
            subtitle: category.description || "เลือกดูสินค้า",
            image_url: category.imageUrl || "https://via.placeholder.com/300x200/EEE/777?text=Category", // Placeholder with text
            buttons: [{ type: "postback", title: `ดูสินค้า ${category.name}`, payload: `CATEGORY_${category.name}` }]
        }));
        await sendGenericTemplate(sender, elements);

        await sendButtonTemplate(sender, "หรือเลือกดำเนินการอื่นๆ:", [
            { type: "postback", title: "🛒 ดูตะกร้า", payload: "CART_VIEW" },
            { type: "web_url", title: "💬 ติดต่อแอดมิน", url: loadedConfig.adminContactLink || '#' },
            { type: "postback", title: "💡 ช่วยเหลือ", payload: "HELP" }
        ]);
    } catch (error) {
        console.error(`Error in showCategories: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในการแสดงหมวดหมู่");
    }
}
async function showProductsByCategory(sender, categoryName, page = 0) {
    try {
        const pageSize = 5; // Products per page
        const skip = page * pageSize;
        const productsInCategory = shopData.products.filter(p => p.category === categoryName);

        // Ensure stock count is accurate before slicing/displaying
        productsInCategory.forEach(p => {
            p.stock = Array.isArray(p.stockItems) ? p.stockItems.length : 0;
        });

        const productsToShow = productsInCategory
            .filter(p => p.stock > 0) // Filter out-of-stock
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)) // Newest first
            .slice(skip, skip + pageSize);

        const totalAvailableProducts = productsInCategory.filter(p => p.stock > 0).length; // Count only available

        if (productsToShow.length === 0) {
            await sendMessage(sender, page === 0 ? `ขออภัย ไม่พบสินค้าพร้อมส่งในหมวดหมู่ "${categoryName}"` : "ไม่มีสินค้าเพิ่มเติมในหมวดหมู่นี้แล้ว");
            await sendButtonTemplate(sender, "กลับไปเลือกหมวดหมู่อื่นๆ", [{ type: "postback", title: "เลือกหมวดหมู่", payload: "SHOW_CATEGORIES" }]);
            return;
        }

        const user = getUserData(sender);
        user.lastCategory = categoryName;
        user.lastViewedProducts = productsToShow.map(p => p.id); // Store IDs of viewed products on this page
        user.currentPage = page;
        saveShopData();

        await sendMessage(sender, `🔎 สินค้าในหมวดหมู่ "${categoryName}" (หน้า ${page + 1}):`);

        const elements = productsToShow.map(product => ({
            title: product.name,
            subtitle: `฿${product.price.toFixed(2)} | ${product.language || 'N/A'} | เหลือ ${product.stock} ชิ้น`,
            image_url: product.imageUrl || "https://via.placeholder.com/300x200/EEE/777?text=Product", // Placeholder
            buttons: [
                { type: "postback", title: "ดูรายละเอียด", payload: `PRODUCT_VIEW_${product.id}` },
                { type: "postback", title: "➕ หยิบใส่ตะกร้า", payload: `PRODUCT_ADD_TO_CART_${product.id}` }
            ]
        }));
        await sendGenericTemplate(sender, elements);

        const buttons = [];
        if (totalAvailableProducts > (page + 1) * pageSize) {
            buttons.push({ type: "postback", title: "➡️ หน้าถัดไป", payload: `MORE_PRODUCTS_${categoryName}_${page + 1}` });
        }
         buttons.push({ type: "postback", title: "กลับไปหมวดหมู่", payload: "SHOW_CATEGORIES" });
         buttons.push({ type: "postback", title: "🛒 ดูตะกร้า", payload: "CART_VIEW" });
        await sendButtonTemplate(sender, `แสดง ${skip + 1}-${skip + productsToShow.length} จาก ${totalAvailableProducts} รายการพร้อมส่ง`, buttons);

    } catch (error) {
        console.error(`Error in showProductsByCategory: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในการแสดงสินค้า");
    }
}
async function showProductDetail(sender, productId) {
    try {
        const product = shopData.products.find(p => p.id === productId);
        if (!product) {
            await sendMessage(sender, "ขออภัย ไม่พบสินค้าที่คุณต้องการ");
            return;
        }
        product.stock = Array.isArray(product.stockItems) ? product.stockItems.length : 0; // Refresh stock count

        await sendImageMessage(sender, product.imageUrl || "https://via.placeholder.com/300x200/EEE/777?text=Product"); // Placeholder
        let detailText = `✨ ${product.name}\n`;
        detailText += `💰 ราคา: ฿${product.price.toFixed(2)}\n`; // Format price
        detailText += `📦 สถานะ: ${product.stock > 0 ? '✅ พร้อมส่ง' : '❌ สินค้าหมด'}\n`;
        if (product.stock > 0) detailText += `📊 คงเหลือ: ${product.stock} ชิ้น\n`;
        if (product.language) detailText += `⌨️ ภาษา: ${product.language}\n`;
        if (product.version) detailText += `🔄 เวอร์ชัน: ${product.version}\n`;
        detailText += `📄 รายละเอียด: ${product.description || 'ไม่มีรายละเอียดเพิ่มเติม'}`;
        await sendMessage(sender, detailText);

        const buttons = [];
        if (product.stock > 0) {
            buttons.push({ type: "postback", title: "➕ หยิบใส่ตะกร้า", payload: `PRODUCT_ADD_TO_CART_${product.id}` });
        }
        buttons.push({ type: "postback", title: "🛒 ดูตะกร้า", payload: "CART_VIEW" });
        buttons.push({ type: "web_url", title: "💬 ติดต่อแอดมิน", url: loadedConfig.adminContactLink || '#' });
        await sendButtonTemplate(sender, "ดำเนินการต่อ:", buttons);

    } catch (error) {
        console.error(`Error in showProductDetail: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในการแสดงรายละเอียดสินค้า");
    }
}
async function addToCart(sender, productId) {
    try {
        const product = shopData.products.find(p => p.id === productId);
        if (!product) return await sendMessage(sender, "ขออภัย ไม่พบสินค้านี้");

        product.stock = Array.isArray(product.stockItems) ? product.stockItems.length : 0; // Refresh stock
        if (product.stock <= 0) return await sendMessage(sender, `ขออภัย ${product.name} หมดสต็อกแล้ว`);

        const user = getUserData(sender);
        const existingItemIndex = user.cart.findIndex(item => item.productId === productId);

        if (existingItemIndex > -1) {
            const currentQuantityInCart = user.cart[existingItemIndex].quantity;
            if (currentQuantityInCart + 1 > product.stock) {
                return await sendMessage(sender, `ขออภัย เพิ่ม ${product.name} ไม่ได้แล้ว มีในสต็อกเพียง ${product.stock} ชิ้น (คุณมีในตะกร้า ${currentQuantityInCart} ชิ้น)`);
            }
            user.cart[existingItemIndex].quantity++;
            await sendMessage(sender, `✅ เพิ่มจำนวน ${product.name} เป็น ${user.cart[existingItemIndex].quantity} ชิ้นในตะกร้า`);
        } else {
            if (1 > product.stock) {
                return await sendMessage(sender, `ขออภัย เพิ่ม ${product.name} ไม่ได้แล้ว มีในสต็อกเพียง ${product.stock} ชิ้น`);
            }
            user.cart.push({
                productId: productId,
                name: product.name,
                price: product.price,
                imageUrl: product.imageUrl,
                quantity: 1
            });
            await sendMessage(sender, `✅ เพิ่ม ${product.name} ลงตะกร้าเรียบร้อย`);
        }
        saveShopData();

        await sendButtonTemplate(sender, "ดำเนินการต่อ:", [
            { type: "postback", title: "🛒 ดูตะกร้า", payload: "CART_VIEW" },
            { type: "postback", title: `กลับไปหมวดหมู่ ${product.category}`, payload: `CATEGORY_${product.category}` },
            { type: "postback", title: "💰 ชำระเงิน", payload: "CHECKOUT" }
        ]);

    } catch (error) {
        console.error(`Error in addToCart: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในการเพิ่มสินค้าลงตะกร้า");
    }
}
async function viewCart(sender) {
    try {
        const user = getUserData(sender);
        if (!user.cart || user.cart.length === 0) {
            await sendMessage(sender, "🗑️ ตะกร้าสินค้าของคุณว่างเปล่า");
            await sendButtonTemplate(sender, "เลือกซื้อสินค้ากัน!", [{ type: "postback", title: "เลือกหมวดหมู่", payload: "SHOW_CATEGORIES" }]);
            return;
        }

        let totalAmount = 0;
        let cartSummary = "🛒 ตะกร้าสินค้าของคุณ:\n\n";
        const cartQuickReplies = [];

        user.cart.forEach((item, index) => {
            const itemTotal = item.price * item.quantity;
            totalAmount += itemTotal;
            cartSummary += `${index + 1}. ${item.name} (฿${item.price.toFixed(2)} x ${item.quantity} = ฿${itemTotal.toFixed(2)})\n`;
            const shortName = item.name.length > 12 ? item.name.substring(0, 10) + '...' : item.name;
            cartQuickReplies.push({
                content_type: "text",
                title: `ลบ ${shortName}`,
                payload: `CART_REMOVE_${item.productId}`
            });
        });
        cartSummary += `\n💰 ยอดรวมทั้งสิ้น: ฿${totalAmount.toFixed(2)}`;

        let autoPromoApplicable = false;
        if (loadedConfig.autoPromotionEnabled &&
            loadedConfig.autoPromotionPercentage > 0 &&
            totalAmount >= loadedConfig.autoPromotionMinPurchase)
        {
            autoPromoApplicable = true;
            const discountValue = totalAmount * (loadedConfig.autoPromotionPercentage / 100);
            cartSummary += `\n\n✨ โปรฯ อัตโนมัติ! ลด ${loadedConfig.autoPromotionPercentage}% (฿${discountValue.toFixed(2)}) เมื่อชำระเงิน`;
            if (loadedConfig.autoPromotionMinPurchase > 0) {
                cartSummary += ` (ซื้อครบ ${loadedConfig.autoPromotionMinPurchase.toFixed(2)}฿)`;
            }
        } else if (loadedConfig.autoPromotionEnabled && loadedConfig.autoPromotionPercentage > 0 && loadedConfig.autoPromotionMinPurchase > 0) {
             const remaining = loadedConfig.autoPromotionMinPurchase - totalAmount;
             if (remaining > 0) {
                 cartSummary += `\n\n✨ ซื้อเพิ่มอีก ฿${remaining.toFixed(2)} เพื่อรับส่วนลด ${loadedConfig.autoPromotionPercentage}%!`;
             }
        }

        await sendMessage(sender, cartSummary);

        if (cartQuickReplies.length > 10) cartQuickReplies.splice(10);
        if (cartQuickReplies.length < 11) cartQuickReplies.push({ content_type: "text", title: "ล้างตะกร้า", payload: "CART_CLEAR" });
        if (cartQuickReplies.length < 12) cartQuickReplies.push({ content_type: "text", title: "💰 ชำระเงิน", payload: "CHECKOUT" });
        if (cartQuickReplies.length < 13 && !autoPromoApplicable) {
            cartQuickReplies.push({ content_type: "text", title: "🏷️ ใช้ส่วนลด", payload: "APPLY_DISCOUNT_PROMPT" });
        }

        await sendQuickReplies(sender, "จัดการตะกร้าสินค้า:", cartQuickReplies);

        const buttons = [ { type: "postback", title: "💰 ชำระเงิน", payload: "CHECKOUT" } ];
        if (!autoPromoApplicable) {
            buttons.push({ type: "postback", title: "🏷️ ใช้ส่วนลด", payload: "APPLY_DISCOUNT_PROMPT" });
        }
         buttons.push({ type: "postback", title: "เลือกซื้อเพิ่ม", payload: "SHOW_CATEGORIES" });

        await sendButtonTemplate(sender, "เลือกดำเนินการต่อ:", buttons);

    } catch (error) {
        console.error(`Error in viewCart: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในการแสดงตะกร้าสินค้า");
    }
}
async function removeFromCart(sender, productId) {
    try {
        const user = getUserData(sender);
        const itemIndex = user.cart.findIndex(item => item.productId === productId);
        if (itemIndex === -1) return await sendMessage(sender, "ไม่พบสินค้านี้ในตะกร้า");

        const removedItemName = user.cart[itemIndex].name;
        user.cart.splice(itemIndex, 1);
        saveShopData();
        await sendMessage(sender, `🗑️ ลบ ${removedItemName} ออกจากตะกร้าแล้ว`);
        await viewCart(sender); // Show updated cart
    } catch (error) {
        console.error(`Error in removeFromCart: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในการลบสินค้า");
    }
}
async function clearCart(sender) {
    try {
        const user = getUserData(sender);
        user.cart = [];
        saveShopData();
        await sendMessage(sender, "🗑️ ล้างตะกร้าสินค้าเรียบร้อยแล้ว");
        await sendButtonTemplate(sender, "เริ่มต้นเลือกซื้อสินค้าใหม่ได้เลย", [{ type: "postback", title: "เลือกหมวดหมู่", payload: "SHOW_CATEGORIES" }]);
    } catch (error) {
        console.error(`Error in clearCart: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในการล้างตะกร้า");
    }
}
// --- End Shop Logic ---

// --- Checkout and Payment Processing ---
async function checkout(sender) {
    try {
        const user = getUserData(sender);
        if (!user.cart || user.cart.length === 0) {
            await sendMessage(sender, "🛒 ตะกร้าของคุณว่างเปล่า ไม่สามารถดำเนินการต่อได้");
            await sendButtonTemplate(sender, "เลือกซื้อสินค้ากัน!", [{ type: "postback", title: "เลือกหมวดหมู่", payload: "SHOW_CATEGORIES" }]);
            return;
        }

        let originalTotalAmount = 0;
        let hasInsufficientStock = false;
        let stockIssues = [];

        for (const item of user.cart) {
            const product = shopData.products.find(p => p.id === item.productId);
            const availableStock = product ? (Array.isArray(product.stockItems) ? product.stockItems.length : 0) : 0;
            if (!product || availableStock < item.quantity) {
                hasInsufficientStock = true;
                stockIssues.push(`${item.name} (ต้องการ ${item.quantity}, มี ${availableStock})`);
            } else {
                originalTotalAmount += item.price * item.quantity;
            }
        }

        if (hasInsufficientStock) {
            await sendMessage(sender, `❌ ขออภัย มีสินค้าบางรายการในตะกร้าไม่เพียงพอ:\n- ${stockIssues.join('\n- ')}\nกรุณาปรับปรุงตะกร้าของคุณก่อน`);
            await viewCart(sender);
            return;
        }

        let autoDiscountAmount = 0;
        let autoPromoApplied = false;
        if (loadedConfig.autoPromotionEnabled &&
            loadedConfig.autoPromotionPercentage > 0 &&
            originalTotalAmount >= loadedConfig.autoPromotionMinPurchase)
        {
            autoDiscountAmount = originalTotalAmount * (loadedConfig.autoPromotionPercentage / 100);
            autoPromoApplied = true;
            console.log(`Auto promotion applied for ${sender}: ${loadedConfig.autoPromotionPercentage}% on ${originalTotalAmount.toFixed(2)} THB. Discount: ${autoDiscountAmount.toFixed(2)} THB`);
        }

        user.checkoutState = {
            originalTotalAmount: originalTotalAmount,
            finalAmount: autoPromoApplied ? (originalTotalAmount - autoDiscountAmount) : originalTotalAmount,
            discountCode: autoPromoApplied ? 'AUTO_PROMO' : null,
            discountAmount: autoPromoApplied ? autoDiscountAmount : 0,
            autoDiscountApplied: autoPromoApplied,
            paymentMethod: null,
            step: autoPromoApplied ? 'select_method' : 'awaiting_discount_or_payment'
        };
        saveShopData();

        await sendMessage(sender, `🛒 ยอดรวมสินค้า: ฿${originalTotalAmount.toFixed(2)}`);

        if (autoPromoApplied) {
            await sendMessage(sender, `✨ ใช้โปรโมชั่นอัตโนมัติสำเร็จ!\nส่วนลด ${loadedConfig.autoPromotionPercentage}%: ฿${autoDiscountAmount.toFixed(2)}\nยอดรวมใหม่: ฿${user.checkoutState.finalAmount.toFixed(2)}`);
            await showPaymentOptions(sender);
        } else {
            await sendQuickReplies(sender, "คุณมีโค้ดส่วนลดหรือไม่?", [
                { content_type: "text", title: "🏷️ มีโค้ด", payload: "APPLY_DISCOUNT_PROMPT" },
                { content_type: "text", title: "⏩ ไม่มี / ข้าม", payload: "SKIP_DISCOUNT" }
            ]);
        }

    } catch (error) {
        console.error(`Error in checkout start: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในการเริ่มขั้นตอนชำระเงิน");
        const user = getUserData(sender);
        if (user.checkoutState) { delete user.checkoutState; saveShopData(); }
    }
}
async function promptForDiscountCode(sender) {
    try {
        const user = getUserData(sender);
        if (!user.checkoutState || !['awaiting_discount_or_payment', 'awaiting_discount_code'].includes(user.checkoutState.step) ) {
             console.warn(`User ${sender} attempted APPLY_DISCOUNT_PROMPT in wrong state: ${user.checkoutState?.step}`);
             if (user.checkoutState?.autoDiscountApplied) {
                 await sendMessage(sender, "ระบบได้ใช้โปรโมชั่นอัตโนมัติให้แล้ว ไม่สามารถใช้โค้ดส่วนลดอื่นได้ครับ");
                 return;
             }
             await sendMessage(sender, "สถานะไม่ถูกต้อง กรุณาลองเริ่มชำระเงินใหม่");
             if (user.checkoutState) { await cancelPayment(sender); }
             return;
        }
        user.checkoutState.step = 'awaiting_discount_code';
        saveShopData();
        await sendMessage(sender, "กรุณาพิมพ์ 'โค้ดส่วนลด' ที่คุณมี:");
        await sendButtonTemplate(sender, "หากไม่มี กดข้าม", [{ type: "postback", title: "⏩ ข้าม", payload: "SKIP_DISCOUNT" }]);
    } catch (error) {
         console.error(`Error in promptForDiscountCode: ${error.message}`);
         await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาด");
    }
}
async function skipDiscountAndProceed(sender) {
    try {
        const user = getUserData(sender);
        if (!user.checkoutState || !['awaiting_discount_or_payment', 'awaiting_discount_code'].includes(user.checkoutState.step)) {
            console.warn(`User ${sender} attempted SKIP_DISCOUNT in wrong state: ${user.checkoutState?.step}`);
            if (user.checkoutState?.autoDiscountApplied && user.checkoutState.step === 'select_method') {
                 await showPaymentOptions(sender);
                 return;
            }
             if (user.checkoutState) await cancelPayment(sender);
            return;
        }
        user.checkoutState.discountCode = null;
        user.checkoutState.discountAmount = 0;
        user.checkoutState.finalAmount = user.checkoutState.originalTotalAmount;
        user.checkoutState.step = 'select_method';
        saveShopData();

        await showPaymentOptions(sender);
    } catch (error) {
        console.error(`Error in skipDiscountAndProceed: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาด");
        if (getUserData(sender).checkoutState) await cancelPayment(sender);
    }
}
async function applyDiscountCode(sender, codeInput) {
    try {
        const user = getUserData(sender);
        const code = codeInput.trim().toUpperCase();

        if (!user.checkoutState || user.checkoutState.step !== 'awaiting_discount_code') {
            console.warn(`User ${sender} sent discount code '${code}' in wrong state: ${user.checkoutState?.step}`);
            if (user.checkoutState?.step === 'select_method') return;
            await sendMessage(sender, "สถานะไม่ถูกต้อง กรุณาเริ่มชำระเงินใหม่");
            if (user.checkoutState) await cancelPayment(sender);
            return;
        }

        if (user.checkoutState.autoDiscountApplied) {
            await sendMessage(sender, "ระบบได้ใช้โปรโมชั่นอัตโนมัติให้แล้ว ไม่สามารถใช้โค้ดส่วนลดอื่นได้ครับ");
            user.checkoutState.step = 'select_method';
            saveShopData();
            await showPaymentOptions(sender);
            return;
        }

        const originalTotal = user.checkoutState.originalTotalAmount;
        const foundCode = discountCodes.find(dc => dc.code === code);

        if (!foundCode) {
            await sendMessage(sender, `⚠️ ไม่พบโค้ดส่วนลด "${code}" กรุณาลองใหม่ หรือกดข้าม`);
            return;
        }
        if (foundCode.expiresAt && new Date(foundCode.expiresAt) < new Date()) {
            await sendMessage(sender, `⚠️ โค้ดส่วนลด "${code}" หมดอายุแล้ว`);
            return;
        }
        if (foundCode.maxUses !== null && (foundCode.uses || 0) >= foundCode.maxUses) {
            await sendMessage(sender, `⚠️ โค้ดส่วนลด "${code}" ถูกใช้ครบจำนวนแล้ว`);
            return;
        }
        if (foundCode.minPurchase > 0 && originalTotal < foundCode.minPurchase) {
            await sendMessage(sender, `⚠️ ต้องมียอดซื้อขั้นต่ำ ฿${foundCode.minPurchase.toFixed(2)} เพื่อใช้โค้ด "${code}" (ยอดปัจจุบัน ฿${originalTotal.toFixed(2)})`);
            return;
        }

        let discountAmount = 0;
        if (foundCode.type === 'percentage') {
            discountAmount = originalTotal * (foundCode.value / 100);
        } else if (foundCode.type === 'fixed') {
            discountAmount = foundCode.value;
        }
        discountAmount = Math.min(discountAmount, originalTotal);

        user.checkoutState.discountCode = foundCode.code;
        user.checkoutState.discountAmount = discountAmount;
        user.checkoutState.finalAmount = originalTotal - discountAmount;
        user.checkoutState.step = 'select_method';
        saveShopData();

        await sendMessage(sender, `✅ ใช้โค้ดส่วนลด "${foundCode.code}" สำเร็จ!\nส่วนลด: ฿${discountAmount.toFixed(2)}\nยอดรวมใหม่: ฿${user.checkoutState.finalAmount.toFixed(2)}`);
        await showPaymentOptions(sender);

    } catch (error) {
        console.error(`Error applying discount code ${codeInput} for ${sender}: ${error.message}`);
        await sendMessage(sender, "❌ ขออภัย เกิดข้อผิดพลาดในการใช้โค้ดส่วนลด");
        if (getUserData(sender).checkoutState) await cancelPayment(sender);
    }
}
async function showPaymentOptions(sender) {
     try {
        const user = getUserData(sender);
        if (!user.checkoutState || user.checkoutState.step !== 'select_method') {
             console.warn(`User ${sender} in showPaymentOptions with wrong state: ${user.checkoutState?.step}`);
             await sendMessage(sender, "สถานะไม่ถูกต้อง กรุณาเริ่มขั้นตอนชำระเงินใหม่");
             if (user.checkoutState) await cancelPayment(sender);
             return;
        }

        const finalAmount = user.checkoutState.finalAmount;

        let summary = `ยอดรวมที่ต้องชำระ: ฿${finalAmount.toFixed(2)}`;
        if (user.checkoutState.discountAmount > 0) {
             const discountSource = user.checkoutState.autoDiscountApplied ? `โปรโมชั่นอัตโนมัติ ${loadedConfig.autoPromotionPercentage}%` : `โค้ด ${user.checkoutState.discountCode}`;
             summary += ` (จาก ฿${user.checkoutState.originalTotalAmount.toFixed(2)}, ส่วนลด ${discountSource}: ฿${user.checkoutState.discountAmount.toFixed(2)})`;
        }
        await sendMessage(sender, summary);
        await sendMessage(sender, "กรุณาเลือกช่องทางการชำระเงิน หรือใช้โค้ดรับของ:");

        const walletImg = loadedConfig.walletImage || "https://via.placeholder.com/300x200/FFF/000?text=Wallet";
        const bankImg = loadedConfig.bankImage || "https://via.placeholder.com/300x200/EEE/777?text=Bank";
        const redeemImg = loadedConfig.codeRedemptionImage || "https://via.placeholder.com/300x200/DDD/555?text=Code";

        const paymentElements = [
            {
                title: "TrueMoney Wallet (ซองอั่งเปา)",
                subtitle: `สร้างและส่งซองอั่งเปามูลค่า ฿${finalAmount.toFixed(2)}`,
                image_url: walletImg,
                buttons: [{ type: "postback", title: "เลือก Wallet", payload: "PAYMENT_ANGPAO" }]
            },
            {
                title: "โอนเงินผ่านธนาคาร",
                subtitle: `โอนเงิน ฿${finalAmount.toFixed(2)}\n${(loadedConfig.bankAccountDetails || '').split('\n')[0]}`,
                image_url: bankImg,
                buttons: [{ type: "postback", title: "เลือก ธนาคาร", payload: "PAYMENT_BANK" }]
            },
            {
                title: "ใช้โค้ดรับของ",
                subtitle: "กรอกโค้ด 32 หลักที่คุณมี",
                image_url: redeemImg,
                buttons: [{ type: "postback", title: "เลือกใช้โค้ด", payload: "PAYMENT_REDEEM_CODE" }]
            }
        ];
        await sendGenericTemplate(sender, paymentElements);
        await sendButtonTemplate(sender, "หากต้องการยกเลิก", [{ type: "postback", title: "❌ ยกเลิก", payload: "CANCEL_PAYMENT" }]);

    } catch (error) {
         console.error(`Error in showPaymentOptions: ${error.message}`);
         await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในการแสดงตัวเลือกชำระเงิน");
         await cancelPayment(sender);
    }
}
async function processPaymentMethod(sender, method) {
    try {
        const user = getUserData(sender);
        if (!user.checkoutState || user.checkoutState.step !== 'select_method') {
            await sendMessage(sender, "สถานะไม่ถูกต้อง กรุณาเริ่มขั้นตอนชำระเงินใหม่");
             if (user.checkoutState) await cancelPayment(sender);
            return;
        }

        const finalAmount = user.checkoutState.finalAmount;
        const cancelButton = { type: "postback", title: "❌ ยกเลิก", payload: "CANCEL_PAYMENT" };

        if (method === 'angpao') {
            if (!loadedConfig.walletPhone || !/^[0-9]{10}$/.test(loadedConfig.walletPhone)) {
                await sendMessage(sender, "❌ ขออภัย ระบบ Wallet ไม่พร้อมใช้งานขณะนี้ กรุณาติดต่อแอดมิน");
                console.error("Angpao Error: Wallet phone number for redeeming is not configured or invalid in settings.");
                await cancelPayment(sender);
                return;
            }
            user.checkoutState.step = 'awaiting_angpao_link';
            user.checkoutState.paymentMethod = 'angpao';
            saveShopData();
            await sendMessage(sender, `📱 กรุณาสร้างซองอั่งเปา TrueMoney Wallet มูลค่า ฿${finalAmount.toFixed(2)}`);
            await sendButtonTemplate(sender, "จากนั้นส่ง 'ลิงก์ซองอั่งเปา' มาที่นี่ (ระบบจะทำการกดรับซองเพื่อยืนยัน)", [cancelButton]);
        } else if (method === 'bank') {
            if (!loadedConfig.bankAccountDetails || loadedConfig.bankAccountDetails.trim().length < 10) {
                 await sendMessage(sender, "❌ ขออภัย ไม่ได้ตั้งค่าข้อมูลบัญชีธนาคาร หรือข้อมูลสั้นเกินไป กรุณาติดต่อแอดมิน");
                 await cancelPayment(sender);
                 return;
            }
            user.checkoutState.step = 'awaiting_bank_slip';
            user.checkoutState.paymentMethod = 'bank';
            saveShopData();
            await sendMessage(sender, `🏦 กรุณาโอนเงินจำนวน ฿${finalAmount.toFixed(2)} มาที่บัญชี:`);
            await sendMessage(sender, loadedConfig.bankAccountDetails);
            await sendButtonTemplate(sender, "เมื่อโอนเสร็จแล้ว กรุณา 'ส่งรูปสลิป' มาที่นี่", [cancelButton]);
        } else if (method === 'redeem_code') {
            user.checkoutState.step = 'awaiting_redeem_code';
            user.checkoutState.paymentMethod = 'redeem_code';
            saveShopData();
            await sendMessage(sender, `🔑 กรุณาส่ง 'โค้ดรับของ' (32 ตัวอักษร) ที่คุณได้รับมา`);
            await sendButtonTemplate(sender, "พิมพ์โค้ดของคุณแล้วส่งได้เลย", [cancelButton]);
        } else {
            await sendMessage(sender, "❌ วิธีการชำระเงินไม่ถูกต้อง");
            user.checkoutState.step = 'select_method'; saveShopData();
             await showPaymentOptions(sender);
        }
    } catch (error) {
        console.error(`Error processing payment method (${method}): ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาด โปรดลองเลือกวิธีชำระเงินอีกครั้ง");
        const user = getUserData(sender);
        if (user.checkoutState) {
            user.checkoutState.step = 'select_method';
            user.checkoutState.paymentMethod = null;
            saveShopData();
            await showPaymentOptions(sender);
         }
    }
}
async function handleCheckoutTextInput(sender, text) {
    try {
        const user = getUserData(sender);
        if (!user.checkoutState) return false;

        if (user.checkoutState.step === 'awaiting_discount_code') {
            await applyDiscountCode(sender, text);
            return true;
        }

        if (user.checkoutState.step === 'awaiting_angpao_link') {
            const LINK_REGEX = /https:\/\/gift\.truemoney\.com\/campaign\/\?v=([a-zA-Z0-9]{35})/;
            const match = text.trim().match(LINK_REGEX);
            if (!match) {
                await sendMessage(sender, "⚠️ ลิงก์ซองอั่งเปาไม่ถูกต้อง กรุณาส่งลิงก์ที่ขึ้นต้นด้วย `https://gift.truemoney.com/...`");
                return true;
            }
            const angpaoLink = match[0];
            const phoneToRedeemWith = loadedConfig.walletPhone;
            const expectedAmount = user.checkoutState.finalAmount;

            if (!phoneToRedeemWith) {
                console.error("Angpao Error: Wallet phone to redeem with is not configured!");
                await sendMessage(sender, "❌ เกิดข้อผิดพลาด: ระบบ Wallet ไม่พร้อมใช้งาน กรุณาติดต่อแอดมิน");
                return true;
            }

            await sendMessage(sender, "⏳ กำลังตรวจสอบและรับซองอั่งเปา...");
            const verificationResult = await verifyAngpaoLink(phoneToRedeemWith, angpaoLink, expectedAmount);

            if (verificationResult.success) {
                await sendMessage(sender, `✅ ${verificationResult.message}`);
                await completeOrder(sender, 'angpao', angpaoLink);
            } else {
                await sendMessage(sender, `❌ การรับซอง ล้มเหลว: ${verificationResult.message}`);
            }
            return true;
        }

        if (user.checkoutState.step === 'awaiting_redeem_code') {
            const code = text.trim().toUpperCase();
            const CODE_LENGTH = 32;
            if (code.length !== CODE_LENGTH || !/^[A-Z0-9]{32}$/.test(code)) {
                await sendMessage(sender, `⚠️ โค้ดไม่ถูกต้อง กรุณาส่งโค้ด ${CODE_LENGTH} ตัวอักษร (A-Z, 0-9)`);
                return true;
            }
            await sendMessage(sender, "⏳ กำลังตรวจสอบโค้ด...");
            const verificationResult = await verifyRedemptionCode(code);
            if (verificationResult.success) {
                await sendMessage(sender, "✅ โค้ดถูกต้อง!");
                const codeIndex = validRedemptionCodes.findIndex(c => c.toUpperCase() === code); // Ensure case-insensitive match here too
                if (codeIndex !== -1) {
                    const removedCode = validRedemptionCodes.splice(codeIndex, 1)[0]; // Get the actual code casing before removing
                    saveValidRedemptionCodes();
                    console.log(`Redemption code ${removedCode} used by ${sender} and removed.`);
                    await completeOrder(sender, 'redeem_code', removedCode); // Pass the actual removed code
                } else {
                     console.warn(`Redemption code ${code} verified but not found in list during removal attempt for ${sender}. Possible race condition.`);
                     await sendMessage(sender, "⚠️ พบปัญหาเล็กน้อยในการลบโค้ด แต่จะดำเนินการสั่งซื้อต่อ กรุณาแจ้งแอดมินหากเกิดปัญหา");
                     await completeOrder(sender, 'redeem_code', code + ' (Removal Issue)');
                }
            } else {
                await sendMessage(sender, `❌ ตรวจสอบโค้ดล้มเหลว: ${verificationResult.message}`);
            }
            return true;
        }
        return false;
    } catch (error) {
        console.error(`Error in handleCheckoutTextInput: ${error.message}`);
        await sendMessage(sender, "❌ ขออภัย เกิดข้อผิดพลาดในการประมวลผลข้อมูลชำระเงิน");
        await sendButtonTemplate(sender, "พบข้อผิดพลาด", [{ type: "postback", title: "❌ ยกเลิก", payload: "CANCEL_PAYMENT" }]);
        return true;
    }
}
async function handleCheckoutImageInput(sender, imageUrl) {
    try {
        const user = getUserData(sender);
        if (!user.checkoutState || user.checkoutState.step !== 'awaiting_bank_slip') return false;

        const expectedAmount = user.checkoutState.finalAmount;
        await sendMessage(sender, "⏳ ได้รับสลิปแล้ว กำลังตรวจสอบ...");
        const verificationResult = await verifyBankSlipXncly(sender, imageUrl, expectedAmount);

        if (verificationResult.success) {
            await sendMessage(sender, `✅ ${verificationResult.message}`);
            const confirmationData = verificationResult.confirmationData || imageUrl;
            await completeOrder(sender, 'bank', confirmationData);
        } else {
            await sendMessage(sender, `❌ ตรวจสอบสลิปล้มเหลว: ${verificationResult.message}`);
        }
        return true;
    } catch (error) {
        console.error(`Error in handleCheckoutImageInput: ${error.message}`);
        await sendMessage(sender, "❌ ขออภัย เกิดข้อผิดพลาดในการประมวลผลสลิป");
        await sendButtonTemplate(sender, "พบข้อผิดพลาด", [{ type: "postback", title: "❌ ยกเลิก", payload: "CANCEL_PAYMENT" }]);
        return true;
    }
}
// --- End Checkout Handling ---

// --- Payment Verification Functions (Angpao REDEEM, Slip transRef) ---
async function verifyAngpaoLink(phoneToRedeemWith, voucherLink, expectedAmount) {
    const LINK_REGEX = /https:\/\/gift\.truemoney\.com\/campaign\/\?v=([a-zA-Z0-9]{35})/;
    const voucherHashMatch = voucherLink.match(LINK_REGEX);
    if (!voucherHashMatch || !voucherHashMatch[1]) {
        return { success: false, message: 'รูปแบบลิงก์ซองอั่งเปาไม่ถูกต้อง' };
    }
    const voucherHash = voucherHashMatch[1];

    if (!phoneToRedeemWith || !/^[0-9]{10}$/.test(phoneToRedeemWith)) {
        console.error("Angpao Redeem Error: Invalid or missing shop wallet phone number in config:", phoneToRedeemWith);
        return { success: false, message: 'ข้อผิดพลาดระบบ: ไม่ได้ตั้งค่าเบอร์ Wallet ร้านค้าสำหรับรับซอง' };
    }

    console.log(`Attempting Angpao Redeem: Hash=${voucherHash}, ShopPhone=${phoneToRedeemWith}, Expected=฿${expectedAmount.toFixed(2)}`);

    try {
        const response = await axios.post(`https://gift.truemoney.com/campaign/vouchers/${voucherHash}/redeem`,
            {
                mobile: phoneToRedeemWith,
                voucher_hash: voucherHash
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'User-Agent': 'FBShopBot/5.1.1'
                 },
                timeout: 25000
             }
        );

        const data = response.data;
        console.log("Angpao Redeem API Response:", JSON.stringify(data, null, 2));

        if (data?.status?.code === 'SUCCESS' && data?.data?.my_ticket) {
            const redeemedAmount = parseFloat(data.data.my_ticket.amount_baht);
            if (isNaN(redeemedAmount)) {
                console.error("Angpao Redeem Error: Could not parse amount_baht from response.");
                return { success: false, message: 'รับซองสำเร็จ แต่ไม่สามารถอ่านจำนวนเงินได้! กรุณาติดต่อแอดมิน' };
            }

            console.log(`Angpao Redeemed Successfully: Amount = ฿${redeemedAmount.toFixed(2)}`);

            if (Math.abs(redeemedAmount - expectedAmount) < 0.01) {
                return { success: true, message: `การรับซองสำเร็จ ยอดเงิน ฿${redeemedAmount.toFixed(2)}` };
            } else {
                console.warn(`Angpao amount mismatch: Redeemed ฿${redeemedAmount.toFixed(2)}, Expected ฿${expectedAmount.toFixed(2)}`);
                return { success: false, message: `รับซองสำเร็จ แต่จำนวนเงินไม่ตรง! (รับได้ ฿${redeemedAmount.toFixed(2)}, ต้องการ ฿${expectedAmount.toFixed(2)}) โปรดติดต่อแอดมินทันที!` };
            }
        } else {
            let errorMessage = data?.status?.message || 'เกิดข้อผิดพลาดที่ไม่รู้จักจาก TrueMoney';
            const errorCode = data?.status?.code;

            if (errorCode === 'VOUCHER_NOT_FOUND' || errorMessage.includes("VOUCHER_NOT_FOUND")) errorMessage = "ไม่พบซองนี้ หรือลิงก์ไม่ถูกต้อง";
            else if (errorCode === 'VOUCHER_OUT_OF_STOCK' || errorMessage.includes("VOUCHER_OUT_OF_STOCK")) errorMessage = "ซองนี้ถูกใช้ไปหมดแล้ว";
            else if (errorCode === 'TARGET_USER_HAS_ALREADY_REDEEMED' || errorMessage.includes("TARGET_USER_HAS_ALREADY_REDEEMED")) errorMessage = "คุณเคยรับซองนี้ไปแล้ว";
            else if (errorCode === 'VOUCHER_EXPIRED' || errorMessage.includes("VOUCHER_EXPIRED")) errorMessage = "ซองนี้หมดอายุแล้ว";
            else if (errorCode === 'CAMPAIGN_ENDED' || errorMessage.includes("CAMPAIGN_ENDED")) errorMessage = "แคมเปญของซองนี้สิ้นสุดแล้ว";
            else if (errorCode === 'OWNER_CANNOT_REDEEM' || errorMessage.includes("OWNER_CANNOT_REDEEM")) errorMessage = "เจ้าของซองไม่สามารถรับเองได้";
            else if (errorCode === 'INTERNAL_ERROR' || errorMessage.includes("INTERNAL_ERROR") || errorMessage.includes("PROCESS_VOUCHER_FAILED")) errorMessage = "ระบบ TrueMoney ขัดข้อง (Internal Error)";
            else if (errorMessage.includes("Insufficient balance in campaign")) errorMessage = "ซองนี้ไม่มีเงินเหลือแล้ว";

            console.error("Angpao Redemption Failed:", errorMessage, "| Full API Response:", data);
            return { success: false, message: `ไม่สามารถรับซองได้: ${errorMessage}` };
        }
    } catch (error) {
        console.error('Angpao Verification/Redeem Network/Request Error:', error);
        let friendlyMessage = 'เกิดข้อผิดพลาดในการเชื่อมต่อกับ TrueMoney';
        if (axios.isAxiosError(error)) {
             if (error.response) {
                 console.error('Angpao API Error Response Status:', error.response.status);
                 console.error('Angpao API Error Response Data:', error.response.data);
                 friendlyMessage += ` (API Status: ${error.response.status})`;
                 const apiErrorMsg = error.response.data?.status?.message;
                 if (apiErrorMsg) {
                    friendlyMessage = `ไม่สามารถรับซองได้: ${apiErrorMsg}`;
                 }
             } else if (error.request) {
                 friendlyMessage = "ไม่สามารถเชื่อมต่อระบบ TrueMoney ได้ (No Response)";
             }
            if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                 friendlyMessage = "การเชื่อมต่อ TrueMoney ใช้เวลานานเกินไป (Timeout)";
            }
        } else {
            friendlyMessage += `: ${error.message}`;
        }
        return { success: false, message: friendlyMessage };
    }
}
async function downloadImageToBuffer(imageUrl) {
     if (!imageUrl || !imageUrl.startsWith('http')) {
         return Promise.reject(new Error("Invalid image URL"));
     }
    return new Promise((resolve, reject) => {
        const chunks = [];
        const protocol = imageUrl.startsWith('https') ? https : http;
        const requestOptions = { timeout: 15000 };

        const req = protocol.get(imageUrl, requestOptions, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                console.log(`Redirecting image download from ${imageUrl} to ${response.headers.location}`);
                 const newUrl = new URL(response.headers.location, imageUrl).href;
                downloadImageToBuffer(newUrl)
                    .then(resolve)
                    .catch(reject);
                req.abort();
                return;
            }

            if (response.statusCode !== 200) {
                response.resume();
                return reject(new Error(`Download fail: Status Code ${response.statusCode}`));
            }

            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve(Buffer.concat(chunks)));
        });

        req.on('error', (err) => reject(new Error(`Download connection error: ${err.message}`)));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Download timed out after 15 seconds'));
        });
    });
}
async function verifyBankSlipXncly(sender, imageUrl, expectedAmount) {
    const clientIdSecret = loadedConfig.xnclyClientIdSecret;
    const checkUrl = loadedConfig.xnclyCheckUrl;
    if (!clientIdSecret || !clientIdSecret.includes(':')) return { success: false, message: 'ไม่ได้ตั้งค่า Xncly ClientID:Secret หรือรูปแบบไม่ถูกต้อง (ใน /admin/settings)' };
    if (!checkUrl || !checkUrl.startsWith('http')) return { success: false, message: 'ไม่ได้ตั้งค่า Xncly CHECK_URL หรือรูปแบบไม่ถูกต้อง (ใน /admin/settings)' };

    console.log(`Verifying Slip (Xncly): URL=${imageUrl}, Expected=฿${expectedAmount.toFixed(2)}`);
    await sendTypingIndicator(sender, 'typing_on');

    try {
        await sendMessage(sender, "กำลังโหลดรูปสลิป...");
        const imageBuffer = await downloadImageToBuffer(imageUrl);
        console.log(`Downloaded buffer size: ${imageBuffer.length} bytes from ${imageUrl}`);
        if (imageBuffer.length < 1000) {
            console.warn("Downloaded image seems very small. Might not be a valid slip.");
        }
        await sendMessage(sender, "โหลดสำเร็จ กำลังส่งไปตรวจสอบ...");

        const formData = new FormData();
        formData.append('ClientID-Secret', clientIdSecret);
        formData.append('image', imageBuffer, { filename: 'slip.jpg', contentType: 'image/jpeg' });

        console.log("Sending slip to Xncly API:", checkUrl);
        const response = await axios.post(checkUrl, formData, {
            headers: {
                ...formData.getHeaders(),
                'User-Agent': 'FBShopBot/5.1.1'
             },
            timeout: 45000
        });
        const data = response.data;
        console.log("Xncly Slip API Response:", JSON.stringify(data, null, 2));

        if (data && data.status === true && data.result?.amount !== undefined && data.result?.transRef !== undefined) {
            const slipAmount = parseFloat(data.result.amount);
            const slipTransRef = data.result.transRef;

            if (!slipTransRef) {
                 console.warn("Xncly API returned success status but missing 'transRef'. Treating as potential error.");
                 return { success: false, message: 'API ตอบกลับสำเร็จแต่ข้อมูล transRef ขาดหาย' };
            }

            console.log(`Xncly Slip Ref (transRef): ${slipTransRef}`);

            if (verifiedSlips.includes(slipTransRef)) {
                console.warn(`Duplicate Slip Detected: transRef ${slipTransRef} already used.`);
                return { success: false, message: 'สลิปนี้ถูกใช้งานไปแล้ว (Ref ซ้ำ)' };
            }

            if (isNaN(slipAmount)) {
                console.error("Xncly API returned invalid amount.");
                 return { success: false, message: 'ไม่สามารถอ่านจำนวนเงินจากสลิปได้ (API ผลลัพธ์ผิดพลาด)' };
            }

            console.log(`Xncly verification successful, Amount: ฿${slipAmount.toFixed(2)}, transRef: ${slipTransRef}`);

            if (Math.abs(slipAmount - expectedAmount) < 0.01) {
                verifiedSlips.push(slipTransRef);
                saveVerifiedSlips();
                console.log(`Stored verified slip transRef: ${slipTransRef}`);

                return { success: true, message: `การยืนยันสลิปสำเร็จ (ยอด: ฿${slipAmount.toFixed(2)})`, confirmationData: slipTransRef };
            } else {
                return { success: false, message: `จำนวนเงินในสลิป (฿${slipAmount.toFixed(2)}) ไม่ตรงกับยอดที่ต้องชำระ (฿${expectedAmount.toFixed(2)})` };
            }
        } else {
            let errorMessage = data?.message || data?.result?.message || 'ไม่สามารถตรวจสอบสลิปได้ (API Error ไม่ทราบสาเหตุ)';
            console.error("Xncly Slip Check Failed:", errorMessage, "| Full Response:", data);
            if (String(errorMessage).includes("ClientID-Secret ไม่ถูกต้อง")) errorMessage = "ข้อมูล API ไม่ถูกต้อง (ตั้งค่าใน Admin)";
            else if (String(errorMessage).includes("Package expired") || String(errorMessage).includes("Invalid quota") || String(errorMessage).includes("Quota limit") ) errorMessage = "โควต้าตรวจสอบสลิปหมด";
            else if (String(errorMessage).includes("Invalid image") || String(errorMessage).includes("Unable read QR") || String(errorMessage).includes("file not found")) errorMessage = "รูปสลิปไม่ถูกต้อง อ่าน QR ไม่ได้ หรือไม่ใช่สลิปที่รองรับ";
            else if (String(errorMessage).includes("Not support bank slip")) errorMessage = `สลิปจากธนาคารนี้ยังไม่รองรับ`;
            else if (String(errorMessage).includes("Duplicate slip")) errorMessage = 'ตรวจพบสลิปซ้ำในระบบของผู้ให้บริการ API';
            else if (data?.status === false && !errorMessage.startsWith('ไม่สามารถ')) errorMessage = `API แจ้งข้อผิดพลาด: ${errorMessage}`;

            return { success: false, message: `ตรวจสอบล้มเหลว: ${errorMessage}` };
        }
    } catch (error) {
        console.error('Xncly Bank Slip Verification Error:', error);
        let friendlyMessage = "เกิดข้อผิดพลาดในการตรวจสอบสลิป";
        if (axios.isAxiosError(error)) {
            if (error.response) {
                console.error('Xncly API Error Response Data:', error.response.data);
                friendlyMessage = `เกิดข้อผิดพลาดจากระบบตรวจสอบ (${error.response.status}): ${error.response.data?.message || error.response.data?.error || error.response.statusText || 'Unknown API Error'}`;
            }
            else if (error.request) friendlyMessage = "ไม่สามารถเชื่อมต่อระบบตรวจสอบสลิปได้";
            else friendlyMessage = `เกิดข้อผิดพลาดตั้งค่า Request: ${error.message}`;
            if (error.code === 'ECONNABORTED' || error.message.toLowerCase().includes('timeout')) friendlyMessage = "ระบบตรวจสอบสลิปใช้เวลานานเกินไป (Timeout)";
        } else if (error.message.includes('Download fail') || error.message.includes('Invalid image URL')) {
             friendlyMessage = `ไม่สามารถโหลดรูปสลิปได้: ${error.message}`;
        } else {
             friendlyMessage += `: ${error.message || 'Unknown error'}`;
        }
        return { success: false, message: friendlyMessage };
    } finally {
        await sendTypingIndicator(sender, 'typing_off');
    }
}
async function verifyRedemptionCode(code) {
    if (!code) return { success: false, message: 'ไม่ได้ระบุโค้ด' };
    console.log(`Verifying Redemption Code: ${code}`);
    const codeIndex = validRedemptionCodes.findIndex(validCode => validCode.toUpperCase() === code.toUpperCase());
    if (codeIndex !== -1) {
        console.log(`Code ${code} is valid.`);
        return { success: true, message: 'โค้ดถูกต้อง' };
    } else {
        console.log(`Code ${code} is invalid or already used.`);
        return { success: false, message: 'โค้ดไม่ถูกต้อง หรือถูกใช้ไปแล้ว' };
    }
}
// --- End Payment Verification ---

// --- Order Completion and Helper Functions ---
async function sendDeliveredItemData(sender, productName, deliveredData) {
    await sendMessage(sender, `🎁 สินค้า: ${productName}\n🔑 ข้อมูลของคุณคือ:\n--------------------`);
    if (deliveredData && String(deliveredData).trim()) {
        const chunks = String(deliveredData).match(/[\s\S]{1,600}/g) || [];
        for(const chunk of chunks) {
            await sendMessage(sender, chunk);
            await new Promise(resolve => setTimeout(resolve, 300));
        }
    } else {
        await sendMessage(sender, "⚠️ ไม่พบข้อมูลสำหรับสินค้านี้! กรุณาติดต่อแอดมิน");
    }
    await sendMessage(sender, `--------------------`);
    await new Promise(resolve => setTimeout(resolve, 500));
}
async function completeOrder(sender, paymentMethod, paymentConfirmation) {
    let orderId = `ORD-${Date.now()}-${sender.slice(-4)}`;
    try {
        const user = getUserData(sender);
        if (!user.checkoutState || !user.cart || user.cart.length === 0) {
            console.error(`Error in completeOrder: User ${sender} has no checkout state or cart for Order ${orderId}.`);
            await sendMessage(sender, "เกิดข้อผิดพลาด: ไม่พบข้อมูลตะกร้า/ชำระเงินของคุณ โปรดติดต่อแอดมิน");
            if (user.checkoutState) { delete user.checkoutState; saveShopData(); }
            return;
        }


        const orderItemsDeepCopy = JSON.parse(JSON.stringify(user.cart));
        const originalTotalAmount = user.checkoutState.originalTotalAmount || 0;
        const discountCodeApplied = user.checkoutState.discountCode || null;
        const discountAmountValue = user.checkoutState.discountAmount || 0;
        const wasAutoPromo = user.checkoutState.autoDiscountApplied === true;
        let deliveredItemsData = [];

        let stockConsumptionError = false;
        let insufficientStockProducts = [];
        for (const item of orderItemsDeepCopy) {
            const productIndex = shopData.products.findIndex(p => p.id === item.productId);
            if (productIndex === -1) {
                console.error(`FATAL: Product ${item.productId} (Name: ${item.name}) not found during order completion for ${sender} (Order ${orderId}).`);
                stockConsumptionError = true;
                insufficientStockProducts.push(`${item.name} (ไม่พบสินค้า!)`);
                continue;
            }
            const product = shopData.products[productIndex];
            if (!Array.isArray(product.stockItems)) product.stockItems = [];

            if (product.stockItems.length < item.quantity) {
                console.error(`FATAL: Insufficient stock for ${product.name} (ID: ${product.id}). Needed ${item.quantity}, Have ${product.stockItems.length}. Order ${orderId} for ${sender}.`);
                stockConsumptionError = true;
                insufficientStockProducts.push(`${product.name} (มี ${product.stockItems.length} / ต้องการ ${item.quantity})`);
                continue;
            }

            const itemsForThisProduct = [];
            for (let i = 0; i < item.quantity; i++) {
                const consumedItem = product.stockItems.shift();
                if (consumedItem === undefined || consumedItem === null || String(consumedItem).trim() === '') {
                    console.error(`FATAL: Consumed invalid stock item (undefined/null/empty) for ${product.name} (Index ${i}) for order ${orderId}. Stock data potentially corrupt.`);
                    stockConsumptionError = true;
                    insufficientStockProducts.push(`${product.name} (ข้อมูลสต็อกผิดพลาด)`);
                    break;
                }
                itemsForThisProduct.push(consumedItem);
            }
             if (stockConsumptionError && itemsForThisProduct.length < item.quantity) {
                 console.log(`Partially consumed items for ${product.name} will not be added to delivered data due to error.`);
             } else if (!stockConsumptionError) {
                 deliveredItemsData.push({
                    productId: item.productId,
                    name: item.name,
                    deliveredData: itemsForThisProduct
                 });
                 product.stock = product.stockItems.length;
                 console.log(`Consumed ${itemsForThisProduct.length} stock items for ${product.name} (Order ${orderId}). Remaining: ${product.stock}`);
             }

             if (stockConsumptionError) break;
        }

        if (stockConsumptionError) {
            console.error(`Order ${orderId} for ${sender} halted due to stock/product error(s): ${insufficientStockProducts.join(', ')}`);
            await sendMessage(sender, `❌ เกิดข้อผิดพลาดร้ายแรงในการตัดสต็อกสินค้า!\n- ${insufficientStockProducts.join('\n- ')}\nคำสั่งซื้อของคุณยังไม่สำเร็จ โปรดติดต่อแอดมินทันทีพร้อมแจ้งปัญหา (รหัส ${orderId})`);
            return;
        }

        console.log(`Stock consumption successful for Order ${orderId}`);

        let discountUpdateError = false;
        if (discountCodeApplied && !wasAutoPromo) {
            const codeIndex = discountCodes.findIndex(dc => dc.code === discountCodeApplied);
            if (codeIndex !== -1) {
                discountCodes[codeIndex].uses = (discountCodes[codeIndex].uses || 0) + 1;
                console.log(`Incremented usage count for discount code ${discountCodeApplied} (Order ${orderId}). New count: ${discountCodes[codeIndex].uses}`);
                try {
                    saveDiscountCodes();
                } catch (err) {
                     console.error(`CRITICAL ERROR: Failed to save discount code usage update for ${discountCodeApplied} (Order ${orderId}):`, err);
                     discountUpdateError = true;
                     await sendMessage(sender, "⚠️ เกิดปัญหาในการบันทึกการใช้ส่วนลดเล็กน้อย (แจ้งแอดมินได้หากต้องการ) แต่คำสั่งซื้อของคุณกำลังดำเนินการต่อ...");
                }
            } else {
                console.warn(`Could not find manual discount code ${discountCodeApplied} to increment usage for order ${orderId}. State inconsistency?`);
            }
        }

        const newOrder = {
            id: orderId,
            userId: sender,
            items: orderItemsDeepCopy.map(item => ({
                productId: item.productId,
                name: item.name,
                price: item.price,
                quantity: item.quantity
            })),
            originalTotalAmount: originalTotalAmount,
            discountCode: discountCodeApplied,
            discountAmount: discountAmountValue,
            finalAmount: user.checkoutState.finalAmount,
            paymentMethod: paymentMethod,
            paymentStatus: 'paid',
            paymentConfirmation: String(paymentConfirmation).substring(0, 500),
            status: 'completed',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        shopData.orders.push(newOrder);
        user.cart = [];
        delete user.checkoutState;
        saveShopData(); // Save ALL data (stock updates, order, user state)

        console.log(`Order ${orderId} completed for user ${sender}. Payment: ${paymentMethod}. Discount: ${discountCodeApplied || 'None'}. Items: ${deliveredItemsData.map(i => i.name + 'x' + i.deliveredData.length).join(', ')}`);

        await sendMessage(sender, `🎉 ขอบคุณสำหรับการสั่งซื้อ!\nรหัสคำสั่งซื้อ: ${orderId}`);
        await sendMessage(sender, "✅ การชำระเงิน/ยืนยันโค้ดเรียบร้อย");
        if (discountAmountValue > 0) {
            const discountSource = wasAutoPromo ? `โปรโมชั่นอัตโนมัติ` : `โค้ด ${discountCodeApplied}`;
             await sendMessage(sender, `🏷️ ใช้ส่วนลด ${discountSource} ${discountAmountValue.toFixed(2)} บาท`);
        }
        await sendMessage(sender, "🚚 กำลังจัดส่งสินค้า...");
        await sendTypingIndicator(sender);

        for (const deliveredItem of deliveredItemsData) {
             const combinedData = deliveredItem.deliveredData.join('\n');
             await sendDeliveredItemData(sender, deliveredItem.name, combinedData);
        }

        await sendTypingIndicator(sender, 'typing_off');
        await sendMessage(sender, "✨ การจัดส่งเสร็จสมบูรณ์! หากมีปัญหา กรุณาติดต่อแอดมินพร้อมแจ้งรหัสคำสั่งซื้อ");
        await sendButtonTemplate(sender, "เลือกดูสินค้าอื่นๆ หรือติดต่อสอบถาม", [
            { type: "postback", title: "เลือกหมวดหมู่อื่น", payload: "SHOW_CATEGORIES" },
            { type: "web_url", title: "💬 ติดต่อแอดมิน", url: loadedConfig.adminContactLink || '#' }
        ]);

    } catch (error) {
        console.error(`Error in completeOrder for user ${sender} (Order ${orderId || 'N/A'}): ${error.message}`, error.stack);
        await sendMessage(sender, "❌ ขออภัย เกิดข้อผิดพลาดร้ายแรงในขั้นตอนสุดท้าย โปรดติดต่อแอดมินพร้อมแจ้งรหัสผู้ใช้ (PSID) และรหัสคำสั่งซื้อ (หากมี) เพื่อตรวจสอบ");
        const user = getUserData(sender);
        if (user.checkoutState) { delete user.checkoutState; saveShopData(); }
    }
}
async function cancelPayment(sender) {
    try {
        const user = getUserData(sender);
        if (user.checkoutState) {
            const prevState = user.checkoutState.step;
            delete user.checkoutState;
            saveShopData();
            await sendMessage(sender, "✅ ยกเลิกขั้นตอนการชำระเงิน/ใช้โค้ด/ส่วนลดแล้ว");
            if (user.cart && user.cart.length > 0) {
                 await viewCart(sender);
             } else {
                 await showCategories(sender);
             }
        } else {
            await sendMessage(sender, "ไม่ได้อยู่ในขั้นตอนการชำระเงิน หรือใช้โค้ด/ส่วนลด");
        }
    } catch (error) {
        console.error(`Error in cancelPayment: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในการยกเลิก");
    }
}
// --- End Order Completion ---

// --- Search, Featured Products, Help Functions ---
async function searchProducts(sender, searchTerm) {
    try {
        if (!searchTerm || searchTerm.trim().length < 2) return await sendMessage(sender, "กรุณาระบุคำค้นหาอย่างน้อย 2 ตัวอักษร");
        const searchTermLower = searchTerm.toLowerCase().trim();
        const results = shopData.products.filter(product => {
            product.stock = Array.isArray(product.stockItems) ? product.stockItems.length : 0;
            return (
                product.stock > 0 &&
                (
                    product.name.toLowerCase().includes(searchTermLower) ||
                    (product.description && product.description.toLowerCase().includes(searchTermLower)) ||
                    (product.language && product.language.toLowerCase().includes(searchTermLower)) ||
                    (product.category && product.category.toLowerCase().includes(searchTermLower)) ||
                    product.id === searchTerm
                )
            );
        });

        if (results.length === 0) {
            await sendMessage(sender, `⚠️ ไม่พบสินค้าที่ตรงกับ "${searchTerm}" (หรือสินค้าหมดสต็อก)`);
            await sendButtonTemplate(sender, "ลองค้นหาใหม่ หรือดูหมวดหมู่", [
                 { type: "postback", title: "ดูหมวดหมู่", payload: "SHOW_CATEGORIES" }
            ]);
            return;
        }

        await sendMessage(sender, `🔎 ผลการค้นหาสำหรับ "${searchTerm}" (${results.length} รายการ):`);
        const elements = results.slice(0, 10).map(product => ({
            title: product.name,
            subtitle: `฿${product.price.toFixed(2)} | ${product.category} | เหลือ ${product.stock}`,
            image_url: product.imageUrl || "https://via.placeholder.com/300x200/EEE/777?text=Result",
            buttons: [
                { type: "postback", title: "ดูรายละเอียด", payload: `PRODUCT_VIEW_${product.id}` },
                { type: "postback", title: "➕ หยิบใส่ตะกร้า", payload: `PRODUCT_ADD_TO_CART_${product.id}` }
            ]
        }));
        await sendGenericTemplate(sender, elements);

        if (results.length > 10) {
            await sendMessage(sender, `แสดงผล 10 รายการแรก หากไม่พบสินค้าที่ต้องการ กรุณาระบุคำค้นหาให้เจาะจงขึ้น`);
        }

        await sendButtonTemplate(sender, "ดำเนินการต่อ:", [
            { type: "postback", title: "ดูหมวดหมู่ทั้งหมด", payload: "SHOW_CATEGORIES" },
            { type: "postback", title: "🛒 ดูตะกร้า", payload: "CART_VIEW" }
        ]);
    } catch (error) {
        console.error(`Error in searchProducts: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในการค้นหา");
    }
}
async function showFeaturedProducts(sender) {
    try {
        shopData.products.forEach(p => {
            p.stock = Array.isArray(p.stockItems) ? p.stockItems.length : 0;
        });

        const featuredProducts = shopData.products
            .filter(p => p.stock > 0)
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
            .slice(0, 5);

        if (featuredProducts.length === 0) {
            await sendMessage(sender, "ตอนนี้ยังไม่มีสินค้าแนะนำพิเศษ หรือสินค้าหมดชั่วคราว");
            await showCategories(sender);
            return;
        }

        await sendMessage(sender, "🌟 สินค้าแนะนำ / มาใหม่ 🌟");
        const elements = featuredProducts.map(product => ({
            title: product.name,
            subtitle: `฿${product.price.toFixed(2)} | ${product.category} | เหลือ ${product.stock}`,
            image_url: product.imageUrl || "https://via.placeholder.com/300x200/EEE/777?text=Featured",
            buttons: [
                { type: "postback", title: "ดูรายละเอียด", payload: `PRODUCT_VIEW_${product.id}` },
                { type: "postback", title: "➕ หยิบใส่ตะกร้า", payload: `PRODUCT_ADD_TO_CART_${product.id}` }
            ]
        }));
        await sendGenericTemplate(sender, elements);

        await sendButtonTemplate(sender, "ดำเนินการต่อ:", [
            { type: "postback", title: "ดูหมวดหมู่ทั้งหมด", payload: "SHOW_CATEGORIES" },
            { type: "postback", title: "🛒 ดูตะกร้า", payload: "CART_VIEW" }
        ]);
    } catch (error) {
        console.error(`Error in showFeaturedProducts: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในการแสดงสินค้าแนะนำ");
    }
}
async function showHelp(sender) {
    try {
        let helpText = `
🤖 คำสั่งช่วยเหลือ & ข้อมูล 🤖

🔹 **คำสั่งพื้นฐาน (พิมพ์ได้เลย):**
   - สินค้า / shop : แสดงหมวดหมู่
   - ตะกร้า / cart : ดูตะกร้า
   - ชำระเงิน / checkout : ไปยังหน้าชำระเงิน/ใช้โค้ด/ส่วนลด
   - แนะนำ / featured : ดูสินค้าแนะนำ
   - ค้นหา [คำ] : ค้นหาสินค้า (เช่น ค้นหา script)
   - ล้างตะกร้า : ลบสินค้าในตะกร้า
   - ยกเลิก : ยกเลิกขั้นตอนที่กำลังทำอยู่ (เช่น ชำระเงิน, กรอกโค้ด)
   - ช่วยเหลือ / help : แสดงข้อความนี้

🔹 **การซื้อสินค้า:**
   1. เลือกหมวดหมู่ -> ดูสินค้า -> ดูรายละเอียด
   2. กด 'หยิบใส่ตะกร้า' (เพิ่มจำนวนได้หากกดซ้ำ)
   3. กด 'ดูตะกร้า' หรือ 'ชำระเงิน'

🔹 **การชำระเงิน/รับของ/ส่วนลด:**
   1. กด 'ชำระเงิน' จากตะกร้า
   2. ระบบจะตรวจสอบ **โปรโมชั่นอัตโนมัติ** (ถ้ามีและเข้าเงื่อนไข)
   3. หากไม่มีโปรฯ อัตโนมัติ: ระบบจะถามหา **โค้ดส่วนลด** (ถ้ามีให้พิมพ์ / ไม่มีให้กดข้าม)
   4. เลือกวิธีชำระ:
      - โอนเงิน: ส่ง 'รูปสลิป' ที่ถูกต้องและยังไม่เคยใช้
      - Wallet: สร้างซองตามยอด แล้วส่ง 'ลิงก์ซองอั่งเปา' (ระบบจะกดรับซองเพื่อยืนยัน)
      - ใช้โค้ด: ส่ง 'โค้ดรับของ 32 หลัก'
   5. ระบบจะส่งสินค้าให้เมื่อตรวจสอบการชำระเงิน/โค้ดสำเร็จ

ติดปัญหา หรือ ต้องการสอบถามเพิ่มเติม? 👇
        `;
        await sendMessage(sender, helpText);
        await sendButtonTemplate(sender, "ติดต่อแอดมิน หรือ กลับไปดูสินค้า:", [
            { type: "web_url", title: "💬 ติดต่อแอดมิน", url: loadedConfig.adminContactLink || '#' },
            { type: "postback", title: "กลับไปดูสินค้า", payload: "SHOW_CATEGORIES" }
        ]);
    } catch (error) {
        console.error(`Error in showHelp: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในการแสดงคำแนะนำ");
    }
}
// --- End Search/Help ---


// --- Facebook Webhook Handling ---
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log("Webhook Verification Attempt:");
    console.log("Mode:", mode);
    console.log("Token Received:", token);
    console.log("Expected Token:", loadedConfig.fbVerifyToken);

    if (mode && token) {
        if (mode === 'subscribe' && token === loadedConfig.fbVerifyToken) {
            console.log('Webhook Verified Successfully!');
            res.status(200).send(challenge);
        } else {
            console.error('Webhook Verification Failed: Mode or Token mismatch.');
            if (!loadedConfig.fbVerifyToken || loadedConfig.fbVerifyToken === DEFAULT_CONFIG.fbVerifyToken) {
                console.error("----> Suggestion: 'Facebook Verify Token' is missing or using default in /admin/settings. Please set a strong, unique token and ensure it matches the one in your Facebook App's Webhook setup. <----");
            } else if (token !== loadedConfig.fbVerifyToken) {
                 console.error("----> Suggestion: The token received from Facebook does NOT match the 'Facebook Verify Token' configured in /admin/settings. Check both values. <----");
            }
            res.sendStatus(403);
        }
    } else {
        console.error("Webhook Verification Failed: Missing 'hub.mode' or 'hub.verify_token' in query parameters.");
        res.sendStatus(400);
    }
});
app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (!loadedConfig.fbPageAccessToken) {
        console.error("Webhook Error: Facebook Page Access Token not configured in /admin/settings. Cannot process incoming messages.");
        return res.status(200).send('EVENT_RECEIVED_BUT_NO_TOKEN');
    }

    if (body.object === 'page') {
        res.status(200).send('EVENT_RECEIVED');

        const processEntry = async (entry) => {
            if (!entry.messaging || !Array.isArray(entry.messaging)) return;
            for (const webhook_event of entry.messaging) {
                if (!webhook_event || !webhook_event.sender || !webhook_event.sender.id) continue;
                const sender_psid = webhook_event.sender.id;

                if (webhook_event.message?.is_echo) {
                    continue;
                }

                console.log(`--- Event --- Sender PSID: ${sender_psid}`);

                try {
                    // await sendApiRequest({ url: 'https://graph.facebook.com/v19.0/me/messages', method: 'POST', json: { recipient: { id: sender_psid }, sender_action: 'mark_seen' } });

                    if (webhook_event.message) {
                        await handleMessage(sender_psid, webhook_event.message);
                    } else if (webhook_event.postback) {
                        await handlePostback(sender_psid, webhook_event.postback);
                    } else if (webhook_event.read) {
                        // Optional handling
                    } else if (webhook_event.delivery) {
                        // Optional handling
                    } else {
                         console.log(`Webhook received unknown event type for ${sender_psid}:`, webhook_event);
                    }
                } catch (error) {
                    console.error(`Error processing event for ${sender_psid}:`, error);
                    if (!(error?.error === 'USER_BLOCKED_OR_RESTRICTED' || (error.message && error.message.includes('USER_BLOCKED_OR_RESTRICTED')))) {
                        // Only log/report non-block errors potentially
                    }
                }
            }
        };

        try {
            for (const entry of body.entry) {
                 await processEntry(entry);
            }
        } catch (batchError) {
             console.error("Error during sequential processing of webhook entries:", batchError);
        }

    } else {
        console.log("Webhook received non-page object:", body.object);
        res.sendStatus(404);
    }
});
// --- End Webhook ---

// --- Message and Postback Handlers ---
async function handleMessage(sender_psid, received_message) {
    console.log(`Handling message from ${sender_psid}: Type=${received_message.attachments?.[0]?.type || 'text'}, Text='${String(received_message.text || '').substring(0, 50)}...'`);
    const user = getUserData(sender_psid);

    // --- Priority 1: Handle specific inputs during CHECKOUT ---
    if (user.checkoutState) {
        let handledInCheckout = false;
        const currentState = user.checkoutState.step;

        if (received_message.text) {
            if (['ยกเลิก', 'cancel'].includes(received_message.text.trim().toLowerCase())) {
                await cancelPayment(sender_psid);
                return;
            }
            handledInCheckout = await handleCheckoutTextInput(sender_psid, received_message.text);
        }
        else if (currentState === 'awaiting_bank_slip' && received_message.attachments?.[0]?.type === 'image' && received_message.attachments[0].payload?.url) {
            handledInCheckout = await handleCheckoutImageInput(sender_psid, received_message.attachments[0].payload.url);
        }
        else if (currentState === 'awaiting_angpao_link' && received_message.attachments?.[0]?.type === 'fallback' && received_message.attachments[0].payload?.url) {
            const fallbackUrl = received_message.attachments[0].payload.url;
            const ANGPAO_REGEX = /https:\/\/gift\.truemoney\.com\/campaign\/\?v=([a-zA-Z0-9]{35})/;
            if (ANGPAO_REGEX.test(fallbackUrl)) {
                console.log('Angpao link detected from fallback attachment');
                handledInCheckout = await handleCheckoutTextInput(sender_psid, fallbackUrl);
            }
        }

        if (handledInCheckout) {
            console.log(`Message handled by checkout logic for step: ${currentState}`);
            return;
        }
        else if (received_message.text || received_message.attachments) {
             console.log(`User ${sender_psid} sent unhandled input during checkout step: ${currentState}`);
             let reminderMsg = "กรุณาดำเนินการตามขั้นตอนปัจจุบัน หรือพิมพ์ 'ยกเลิก' เพื่อออก";
             if (currentState === 'awaiting_discount_code') reminderMsg = "กรุณาส่ง 'โค้ดส่วนลด' ที่ถูกต้อง, กด 'ข้าม' หรือพิมพ์ 'ยกเลิก'";
             else if (currentState === 'awaiting_angpao_link') reminderMsg = "กรุณาส่ง 'ลิงก์ซองอั่งเปา' ที่ถูกต้อง หรือพิมพ์ 'ยกเลิก'";
             else if (currentState === 'awaiting_bank_slip') reminderMsg = "กรุณา 'ส่งรูปสลิป' หรือพิมพ์ 'ยกเลิก'";
             else if (currentState === 'awaiting_redeem_code') reminderMsg = "กรุณาส่ง 'โค้ด 32 หลัก' ที่ถูกต้อง หรือพิมพ์ 'ยกเลิก'";
             else if (currentState === 'select_method') reminderMsg = "กรุณาเลือกวิธีการชำระเงินจากปุ่มด้านบน หรือพิมพ์ 'ยกเลิก'";
             await sendMessage(sender_psid, reminderMsg);
             return;
        }
    }
    // --- END Checkout Input Handling ---

    // --- Priority 2: Quick Replies ---
    if (received_message.quick_reply?.payload) {
        console.log(`Quick Reply Payload: ${received_message.quick_reply.payload}`);
        await handlePostbackPayload(sender_psid, received_message.quick_reply.payload);
        return;
    }

    // --- Priority 3: General Attachments ---
    if (received_message.attachments?.length > 0) {
        const attachmentType = received_message.attachments[0].type;
        console.log(`Received unhandled attachment type: ${attachmentType} from ${sender_psid}`);
        if (attachmentType === 'sticker') {
             // await sendMessage(sender_psid, "สติกเกอร์น่ารัก!");
        } else if (attachmentType === 'location') {
             await sendMessage(sender_psid, "ขอบคุณสำหรับตำแหน่งครับ แต่ร้านเราส่งสินค้าออนไลน์นะ 😊");
        } else if (attachmentType === 'audio' || attachmentType === 'video' || attachmentType === 'file') {
             await sendMessage(sender_psid, `ขอบคุณสำหรับไฟล์ ${attachmentType} ครับ 👍 แต่ระบบยังไม่รองรับไฟล์ประเภทนี้โดยตรง`);
        } else {
             await sendMessage(sender_psid, `ได้รับ ${attachmentType} แล้วครับ 👍`);
        }
        return;
    }

    // --- Priority 4: Text Commands (Only if NOT in checkout state) ---
    if (received_message.text) {
        let text = received_message.text.trim();
        const textLower = text.toLowerCase();
        console.log(`Received text command from ${sender_psid}: "${text}"`);

        if (['hi', 'hello', 'สวัสดี', 'หวัดดี', 'ดี', 'hey'].includes(textLower)) {
            await sendMessage(sender_psid, "สวัสดีครับ! พิมพ์ 'สินค้า' เพื่อดูรายการ หรือ 'ช่วยเหลือ' เพื่อดูคำสั่งครับ 😊");
        } else if (['สินค้า', 'shop', 'menu', 'เมนู', 'product', 'products'].includes(textLower)) await showCategories(sender_psid);
        else if (['ตะกร้า', 'cart', 'ดูตะกร้า'].includes(textLower)) await viewCart(sender_psid);
        else if (['ชำระเงิน', 'checkout', 'จ่ายเงิน', 'payment'].includes(textLower)) await checkout(sender_psid);
        else if (['ช่วยเหลือ', 'help', 'คำสั่ง', 'command', 'commands'].includes(textLower)) await showHelp(sender_psid);
        else if (['แนะนำ', 'featured', 'มาใหม่', 'recommend'].includes(textLower)) await showFeaturedProducts(sender_psid);
        else if (['ล้างตะกร้า', 'clear cart'].includes(textLower)) await clearCart(sender_psid);
        else if (['ยกเลิก', 'cancel'].includes(textLower)) await sendMessage(sender_psid, "หากต้องการยกเลิกขั้นตอนการชำระเงิน กรุณาเริ่มขั้นตอนนั้นก่อน แล้วพิมพ์ 'ยกเลิก' หรือกดปุ่มยกเลิกครับ");
        else if (textLower.startsWith('ค้นหา ') || textLower.startsWith('search ')) {
            const searchTerm = text.substring(textLower.indexOf(' ') + 1).trim();
            await searchProducts(sender_psid, searchTerm);
        } else if (['ขอบคุณ', 'ขอบใจ', 'thanks', 'thank you', 'ty'].includes(textLower)) {
            await sendMessage(sender_psid, "ยินดีเสมอครับ! 😊");
        }
        else {
            await sendMessage(sender_psid, `ขออภัย ไม่เข้าใจคำสั่ง "${text}"\nลองพิมพ์ 'ช่วยเหลือ' เพื่อดูคำสั่งทั้งหมดนะครับ`);
        }
        return;
    }

    console.log(`Received unhandled message content from ${sender_psid}:`, JSON.stringify(received_message));
}
async function handlePostback(sender_psid, received_postback) {
    let payload = received_postback.payload;
    let referral = received_postback.referral;
    if (referral) {
        console.log(`Handling postback with referral from ${sender_psid}, Ref: ${JSON.stringify(referral)} Payload: ${payload}`);
        if (!payload) payload = 'GET_STARTED';
    } else {
        console.log(`Handling postback from ${sender_psid}, Payload: ${payload}`);
    }

    await handlePostbackPayload(sender_psid, payload);
}
// Central handler for both Postbacks and Quick Replies Payloads
async function handlePostbackPayload(sender_psid, payload) {
    const user = getUserData(sender_psid);
    console.log(`Processing Payload: "${payload}" for User: ${sender_psid}, Checkout State: ${user.checkoutState?.step || 'None'}`);

    try {
        const requiresCheckoutState = [
            'APPLY_DISCOUNT_PROMPT', 'SKIP_DISCOUNT', 'PAYMENT_ANGPAO',
            'PAYMENT_BANK', 'PAYMENT_REDEEM_CODE', 'CANCEL_PAYMENT'
        ];
        const isCheckoutAction = requiresCheckoutState.includes(payload);

        if (isCheckoutAction && !user.checkoutState) {
            console.warn(`Ignoring stale checkout button "${payload}" from ${sender_psid}.`);
            await sendMessage(sender_psid, "ปุ่มนี้อาจเก่าเกินไป หากต้องการเริ่มชำระเงิน กด 'ดูตะกร้า' แล้วกด 'ชำระเงิน' ครับ");
            return;
        }

         if (payload.startsWith('PAYMENT_') && user.checkoutState?.step !== 'select_method') {
             console.warn(`Ignoring payment button "${payload}" from ${sender_psid} in wrong state (${user.checkoutState?.step}).`);
             await sendMessage(sender_psid, "กรุณาทำตามขั้นตอนปัจจุบันก่อนเลือกวิธีชำระเงินครับ (หรือกด 'ยกเลิก' เพื่อเริ่มใหม่)");
             return;
         }
         if ((payload === 'APPLY_DISCOUNT_PROMPT' || payload === 'SKIP_DISCOUNT')) {
            if (!user.checkoutState || !['awaiting_discount_or_payment', 'awaiting_discount_code'].includes(user.checkoutState.step)) {
                console.warn(`Ignoring discount button "${payload}" from ${sender_psid} in invalid state (${user.checkoutState?.step}).`);
                if (user.checkoutState?.autoDiscountApplied) {
                     await sendMessage(sender_psid, "ระบบได้ใช้โปรโมชั่นอัตโนมัติแล้ว ไม่สามารถใช้โค้ดอื่นได้ครับ");
                } else {
                     await sendMessage(sender_psid, "ไม่สามารถใช้ส่วนลดในขั้นตอนนี้ได้ (หรือปุ่มอาจเก่าเกินไป)");
                }
                return;
            }
         }

        // --- Payload Routing ---
        if (payload === 'GET_STARTED') {
            await sendImageMessage(sender_psid, loadedConfig.welcomeGif);
            await sendMessage(sender_psid, "สวัสดีครับ! ยินดีต้อนรับสู่ร้านค้า 😊");
            await showCategories(sender_psid);
        }
        else if (payload === 'SHOW_CATEGORIES') await showCategories(sender_psid);
        else if (payload.startsWith('CATEGORY_')) {
            const categoryName = payload.substring('CATEGORY_'.length);
            await showProductsByCategory(sender_psid, categoryName, 0);
        }
        else if (payload.startsWith('MORE_PRODUCTS_')) {
            const parts = payload.substring('MORE_PRODUCTS_'.length).split('_');
            const page = parseInt(parts.pop(), 10);
            const categoryName = parts.join('_');
            if (!isNaN(page) && page >= 0 && categoryName) {
                await showProductsByCategory(sender_psid, categoryName, page);
            } else {
                console.error(`Invalid MORE_PRODUCTS payload format: "${payload}"`);
                await sendMessage(sender_psid, "เกิดข้อผิดพลาดในการโหลดหน้าถัดไป");
            }
        }
        else if (payload.startsWith('PRODUCT_VIEW_')) {
            const productId = payload.substring('PRODUCT_VIEW_'.length);
            await showProductDetail(sender_psid, productId);
        }
        else if (payload === 'CART_VIEW') await viewCart(sender_psid);
        else if (payload === 'CART_CLEAR') await clearCart(sender_psid);
        else if (payload.startsWith('PRODUCT_ADD_TO_CART_')) {
            const productId = payload.substring('PRODUCT_ADD_TO_CART_'.length);
            await addToCart(sender_psid, productId);
        } else if (payload.startsWith('CART_REMOVE_')) {
            const productId = payload.substring('CART_REMOVE_'.length);
            await removeFromCart(sender_psid, productId);
        }
        else if (payload === 'CHECKOUT') await checkout(sender_psid);
        else if (payload === 'APPLY_DISCOUNT_PROMPT') await promptForDiscountCode(sender_psid);
        else if (payload === 'SKIP_DISCOUNT') await skipDiscountAndProceed(sender_psid);
        else if (payload === 'PAYMENT_ANGPAO') await processPaymentMethod(sender_psid, 'angpao');
        else if (payload === 'PAYMENT_BANK') await processPaymentMethod(sender_psid, 'bank');
        else if (payload === 'PAYMENT_REDEEM_CODE') await processPaymentMethod(sender_psid, 'redeem_code');
        else if (payload === 'CANCEL_PAYMENT') await cancelPayment(sender_psid);
        else if (payload === 'HELP') await showHelp(sender_psid);
        else if (payload === 'FEATURED_PRODUCTS') await showFeaturedProducts(sender_psid);
        else {
            console.warn(`Unhandled payload received: "${payload}" from ${sender_psid}`);
            if (!isCheckoutAction) {
                 await sendMessage(sender_psid, "ขออภัย ไม่รู้จักคำสั่งนี้ หรืออาจเป็นปุ่มเก่า");
            }
        }
    } catch (error) {
        console.error(`Error handling payload "${payload}" for ${sender_psid}:`, error);
        await sendMessage(sender_psid, "ขออภัย เกิดข้อผิดพลาด โปรดลองอีกครั้ง หรือติดต่อแอดมิน");
        const currentUser = getUserData(sender_psid);
        if (currentUser.checkoutState) {
             console.log(`Attempting to cancel payment state for user ${sender_psid} after error during payload handling.`);
             await cancelPayment(sender_psid);
        } else {
             console.log(`Showing categories for user ${sender_psid} after error during non-checkout payload handling.`);
             await showCategories(sender_psid);
        }
    }
}
// --- End Handlers ---

// --- Admin Dashboard Setup and Routes ---
function validateImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const trimmedUrl = url.trim();
    const pattern = /^https:\/\/.+\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i;
    return pattern.test(trimmedUrl);
}

const viewsDir = path.join(__dirname, 'views');
if (!fs.existsSync(viewsDir)) fs.mkdirSync(viewsDir, { recursive: true });
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

// --- Admin Routes ---
app.get('/admin', (req, res) => {
    try {
        shopData.products.forEach(p => { p.stock = Array.isArray(p.stockItems) ? p.stockItems.length : 0; });

        const completedOrders = shopData.orders.filter(o => o.status === 'completed');
        const totalRevenue = completedOrders
            .reduce((sum, o) => sum + (o.finalAmount !== undefined ? o.finalAmount : ((o.originalTotalAmount || 0) - (o.discountAmount || 0))), 0);
        const totalDiscountsGiven = completedOrders
             .reduce((sum, o) => sum + (o.discountAmount || 0), 0);
        const activeDiscountCodes = discountCodes.filter(dc =>
                (!dc.expiresAt || new Date(dc.expiresAt) >= new Date()) &&
                (dc.maxUses === null || (dc.uses || 0) < dc.maxUses)
            ).length;

        const stats = {
            totalProducts: shopData.products.length,
            totalCategories: shopData.categories.length,
            totalOrders: shopData.orders.length,
            completedOrders: completedOrders.length,
            totalRevenue: totalRevenue.toFixed(2),
            totalDiscountsGiven: totalDiscountsGiven.toFixed(2),
            activeDiscountCodes: activeDiscountCodes,
            autoPromotionStatus: loadedConfig.autoPromotionEnabled
                ? `เปิดใช้งาน (${loadedConfig.autoPromotionPercentage}% เมื่อซื้อครบ ${loadedConfig.autoPromotionMinPurchase.toFixed(2)}฿)`
                : 'ปิดใช้งาน',
            recentOrders: [...shopData.orders]
                .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
                .slice(0, 5)
        };
        res.render('dashboard', { stats, pageTitle: 'Dashboard' });
    } catch (error) {
        console.error("Error rendering dashboard:", error);
        res.status(500).send("Error loading dashboard.");
    }
});

// --- Facebook Connection Check Function ---
async function checkFacebookConnection() {
    if (!loadedConfig.fbPageAccessToken) {
        return { status: 'error', message: '❌ ยังไม่ได้ตั้งค่า Page Access Token' };
    }
    try {
        const response = await axios.get(`https://graph.facebook.com/v19.0/me`, {
            params: {
                fields: 'id,name',
                access_token: loadedConfig.fbPageAccessToken
            },
            timeout: 10000
        });

        if (response.status === 200 && response.data && response.data.id) {
            console.log("Facebook connection check successful:", response.data.name);
            return { status: 'success', message: `✅ เชื่อมต่อสำเร็จ (เพจ: ${response.data.name} - ${response.data.id})` };
        } else {
            console.error("Facebook connection check failed: Unexpected response", response.status, response.data);
            return { status: 'error', message: `❌ เชื่อมต่อล้มเหลว (สถานะ: ${response.status})` };
        }
    } catch (error) {
        console.error("Facebook connection check error:", error.message);
        let errorMsg = '❌ เชื่อมต่อล้มเหลว';
        if (axios.isAxiosError(error)) {
            if (error.response) {
                 const fbError = error.response.data?.error;
                 if (fbError) {
                     errorMsg += `: ${fbError.message || fbError.type || 'API Error'}`;
                     if (fbError.type === 'OAuthException') errorMsg += ' (Token ไม่ถูกต้อง?)';
                     else if (fbError.code === 190) errorMsg += ' (Token หมดอายุ/ไม่ถูกต้อง?)';
                 } else {
                      errorMsg += ` (HTTP ${error.response.status})`;
                 }
            } else if (error.request) {
                 errorMsg += ' (ไม่สามารถเชื่อมต่อ Facebook)';
            } else {
                 errorMsg += ` (ผิดพลาด: ${error.message})`;
            }
             if (error.code === 'ECONNABORTED') errorMsg = '❌ เชื่อมต่อล้มเหลว (หมดเวลา)';
             else if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') errorMsg = '❌ เชื่อมต่อล้มเหลว (ปัญหา DNS/Network)';
        } else {
            errorMsg += ` (ผิดพลาด: ${error.message})`;
        }
        return { status: 'error', message: errorMsg };
    }
}

// --- Settings Route ---
app.get('/admin/settings', async (req, res) => {
    try {
        const connectionCheck = await checkFacebookConnection();
        res.render('settings', {
            config: { ...loadedConfig },
            message: req.query.message,
            error: req.query.error,
            connectionStatus: connectionCheck,
            pageTitle: 'Settings'
        });
    } catch (renderError) {
        console.error("Error rendering settings page:", renderError);
        res.status(500).send("Error loading settings page.");
    }
});
app.post('/admin/settings/save', (req, res) => {
    try {
        const oldVerifyToken = loadedConfig.fbVerifyToken;
        const oldAccessToken = loadedConfig.fbPageAccessToken;
        const oldPort = loadedConfig.serverPort;
        const oldHttps = loadedConfig.enableHttps;
        const oldKeyPath = loadedConfig.sslKeyPath;
        const oldCertPath = loadedConfig.sslCertPath;

        let restartNeeded = false;
        let errors = [];

        // --- Facebook ---
        loadedConfig.fbVerifyToken = req.body.fbVerifyToken?.trim() || '';
        loadedConfig.fbPageAccessToken = req.body.fbPageAccessToken?.trim() || '';
        loadedConfig.adminContactLink = req.body.adminContactLink?.trim() || '';
        loadedConfig.welcomeGif = req.body.welcomeGif?.trim() || DEFAULT_CONFIG.welcomeGif;
        if (!loadedConfig.fbVerifyToken) errors.push("Facebook Verify Token ห้ามว่าง");
        if (loadedConfig.adminContactLink && !loadedConfig.adminContactLink.startsWith('https://m.me/')) errors.push("รูปแบบ ลิงก์ติดต่อแอดมิน ไม่ถูกต้อง (ควรเป็น https://m.me/...)");

        // --- Wallet ---
        loadedConfig.walletPhone = req.body.walletPhone?.trim() || '';
        loadedConfig.walletImage = req.body.walletImage?.trim() || DEFAULT_CONFIG.walletImage;
        if (!loadedConfig.walletPhone || !/^[0-9]{10}$/.test(loadedConfig.walletPhone)) {
            errors.push("เบอร์ Wallet ร้านค้า (สำหรับรับซอง) ต้องเป็น 10 หลัก และห้ามว่าง");
        }

        // --- Bank ---
        loadedConfig.bankAccountDetails = req.body.bankAccountDetails?.trim() || '';
        loadedConfig.bankImage = req.body.bankImage?.trim() || DEFAULT_CONFIG.bankImage;
        if (loadedConfig.bankAccountDetails.length < 10) errors.push("ข้อมูลบัญชีธนาคาร สั้นเกินไป (ต้องระบุ ธนาคาร, เลข, ชื่อ)");

        // --- Xncly ---
        loadedConfig.xnclyClientIdSecret = req.body.xnclyClientIdSecret?.trim() || '';
        loadedConfig.xnclyCheckUrl = req.body.xnclyCheckUrl?.trim() || DEFAULT_CONFIG.xnclyCheckUrl;
        if (!loadedConfig.xnclyClientIdSecret.includes(':')) errors.push("รูปแบบ Xncly ClientID:Secret ไม่ถูกต้อง");
        if (!loadedConfig.xnclyCheckUrl.startsWith('http')) errors.push("รูปแบบ Xncly Check URL ไม่ถูกต้อง");

        // --- Images ---
        loadedConfig.codeRedemptionImage = req.body.codeRedemptionImage?.trim() || DEFAULT_CONFIG.codeRedemptionImage;
        loadedConfig.discountImage = req.body.discountImage?.trim() || DEFAULT_CONFIG.discountImage;

        // --- Auto Promotion ---
        loadedConfig.autoPromotionEnabled = req.body.autoPromotionEnabled === 'on';
        loadedConfig.autoPromotionPercentage = parseFloat(req.body.autoPromotionPercentage) || 0;
        loadedConfig.autoPromotionMinPurchase = parseFloat(req.body.autoPromotionMinPurchase) || 0;
        if (loadedConfig.autoPromotionPercentage < 0 || loadedConfig.autoPromotionPercentage > 100) errors.push("เปอร์เซ็นต์โปรโมชั่น ต้องอยู่ระหว่าง 0-100");
        if (loadedConfig.autoPromotionMinPurchase < 0) errors.push("ยอดซื้อขั้นต่ำโปรโมชั่น ห้ามติดลบ");

        // --- Server & Connection ---
        const newPort = parseInt(req.body.serverPort, 10);
        const newEnableHttps = req.body.enableHttps === 'on';
        const newSslKeyPath = req.body.sslKeyPath?.trim() || '';
        const newSslCertPath = req.body.sslCertPath?.trim() || '';

        if (!isNaN(newPort) && newPort > 0 && newPort <= 65535) {
            loadedConfig.serverPort = newPort;
        } else {
            errors.push("Port ไม่ถูกต้อง (ต้องเป็นเลข 1-65535)");
        }
        loadedConfig.enableHttps = newEnableHttps;
        loadedConfig.sslKeyPath = newSslKeyPath;
        loadedConfig.sslCertPath = newSslCertPath;

        if (newEnableHttps && (!newSslKeyPath || !newSslCertPath)) {
            errors.push("หากเปิด HTTPS ต้องระบุ SSL Key Path และ SSL Cert Path");
        }

        if (loadedConfig.serverPort !== oldPort || loadedConfig.enableHttps !== oldHttps || loadedConfig.sslKeyPath !== oldKeyPath || loadedConfig.sslCertPath !== oldCertPath) {
            restartNeeded = true;
        }

        // --- Final Check & Save ---
        if (errors.length > 0) {
             throw new Error(errors.join('\\n')); // Use \\n for multi-line alert in EJS
        }

        saveConfig();
        console.log("Admin: Settings updated.");
        let message = "บันทึกการตั้งค่าสำเร็จ";
        if (restartNeeded) {
            message += " ⚠️ กรุณารีสตาร์ทเซิร์ฟเวอร์เพื่อให้การตั้งค่า Port/HTTPS มีผล!";
            console.warn("Server configuration changed. RESTART REQUIRED for changes to take effect.");
        }
        if (loadedConfig.fbVerifyToken !== oldVerifyToken || loadedConfig.fbPageAccessToken !== oldAccessToken) {
            message += " (Token เปลี่ยนแปลงแล้ว ลองตรวจสอบสถานะเชื่อมต่ออีกครั้ง)";
        }
        console.log(`Server Settings Saved: Port=${loadedConfig.serverPort}, HTTPS=${loadedConfig.enableHttps}, Key=${loadedConfig.sslKeyPath}, Cert=${loadedConfig.sslCertPath}`);
        console.log(`Auto Promotion status saved: Enabled=${loadedConfig.autoPromotionEnabled}, Percentage=${loadedConfig.autoPromotionPercentage}, MinPurchase=${loadedConfig.autoPromotionMinPurchase}`);

        res.redirect('/admin/settings?message=' + encodeURIComponent(message));
    } catch (error) {
        console.error("Error saving settings:", error);
        res.redirect('/admin/settings?error=' + encodeURIComponent('ผิดพลาด:\\n' + error.message));
    }
});
// --- End Settings Route ---

// --- Product Routes ---
app.get('/admin/products', (req, res) => {
    try {
        shopData.products.forEach(p => { p.stock = Array.isArray(p.stockItems) ? p.stockItems.length : 0; });
        const sortedProducts = [...shopData.products].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        res.render('products', {
             products: sortedProducts,
             categories: shopData.categories,
             message: req.query.message,
             error: req.query.error,
             pageTitle: 'Products'
         });
    } catch (error) {
        console.error("Error rendering products page:", error);
        res.status(500).send("Error loading product data.");
    }
});
app.post('/admin/products/add', (req, res) => {
    let errorMsg = '', successMsg = '';
    try {
        const { name, price, category, description, language, version, imageUrl, stockItemsInput } = req.body;
        let errors = [];

        if (!name?.trim()) errors.push('ชื่อสินค้าห้ามว่าง');
        if (!price) errors.push('ราคาห้ามว่าง');
        if (!category) errors.push('ต้องเลือกหมวดหมู่');
        if (!imageUrl?.trim()) errors.push('URL รูปภาพห้ามว่าง');
        if (!stockItemsInput?.trim()) errors.push('ข้อมูลสต็อกห้ามว่าง');

        const parsedPrice = parseFloat(price);
        if (isNaN(parsedPrice) || parsedPrice < 0) errors.push('ราคาไม่ถูกต้อง');
        if (imageUrl && !validateImageUrl(imageUrl)) errors.push('รูปแบบ URL รูปภาพไม่ถูกต้อง (ต้องเป็น https และลงท้ายด้วย .jpg, .png, .gif, .webp)');
        if (category && !shopData.categories.some(cat => cat.name === category)) errors.push('หมวดหมู่ที่เลือกไม่มีอยู่จริง');

        const stockItems = stockItemsInput ? stockItemsInput.split('\n').map(line => line.trim()).filter(line => line.length > 0) : [];
        if (stockItems.length === 0 && stockItemsInput?.trim()) {
             errors.push('ข้อมูลสต็อกต้องมีอย่างน้อย 1 บรรทัด (ไม่นับบรรทัดว่าง)');
        } else if (stockItems.length === 0 && !stockItemsInput?.trim()){
             errors.push('ข้อมูลสต็อกห้ามว่าง (ต้องมีอย่างน้อย 1 บรรทัด)');
        }

        if (errors.length > 0) throw new Error(errors.join(', '));

        const newProduct = {
            id: `P-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            name: name.trim(),
            price: parsedPrice,
            stockItems: stockItems,
            stock: stockItems.length,
            category: category,
            description: description ? description.trim() : '',
            language: language ? language.trim() : '',
            version: version ? version.trim() : '',
            imageUrl: imageUrl.trim(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        shopData.products.push(newProduct);
        saveShopData();
        successMsg = `เพิ่มสินค้า "${newProduct.name}" สำเร็จ (${newProduct.stock} ชิ้น).`;
        console.log(`Admin: ${successMsg} (ID: ${newProduct.id})`);
        res.redirect(`/admin/products?message=${encodeURIComponent(successMsg)}`);
    } catch (error) {
        console.error("Error adding product:", error);
        errorMsg = `ผิดพลาด: ${error.message}`;
        res.redirect(`/admin/products?error=${encodeURIComponent(errorMsg)}`);
    }
});
// This is the route handler that seemed problematic
app.post('/admin/products/edit/:id', (req, res) => {
     let errorMsg = '', successMsg = '';
     const { id } = req.params;
     console.log(`Admin: Attempting to edit product ID: ${id}`);
    try {
        const { name, price, category, description, language, version, imageUrl, stockItemsToAdd } = req.body;
        let errors = [];

        console.log("Received data for edit:", { name, price, category, imageUrl, stockItemsToAdd: stockItemsToAdd?.substring(0, 50) + '...' }); // Log received data

        if (!name?.trim()) errors.push('ชื่อสินค้าห้ามว่าง');
        if (!price) errors.push('ราคาห้ามว่าง');
        if (!category) errors.push('ต้องเลือกหมวดหมู่');
        if (!imageUrl?.trim()) errors.push('URL รูปภาพห้ามว่าง');

         const parsedPrice = parseFloat(price);
        if (isNaN(parsedPrice) || parsedPrice < 0) errors.push('ราคาไม่ถูกต้อง');
        if (imageUrl && !validateImageUrl(imageUrl)) errors.push('รูปแบบ URL รูปภาพไม่ถูกต้อง');
        if (category && !shopData.categories.some(cat => cat.name === category)) errors.push('หมวดหมู่ที่เลือกไม่มีอยู่จริง');

        const productIndex = shopData.products.findIndex(p => p.id === id);
        if (productIndex === -1) {
            console.error(`Admin Error: Product ID ${id} not found for editing.`);
            throw new Error('ไม่พบสินค้าที่ต้องการแก้ไข');
        }

        const itemsToAdd = stockItemsToAdd ? stockItemsToAdd.split('\n').map(line => line.trim()).filter(line => line.length > 0) : [];
        console.log(`Parsed items to add for product ${id}: ${itemsToAdd.length}`);

         if (errors.length > 0) {
             console.log(`Validation errors for editing product ${id}:`, errors);
             throw new Error(errors.join(', '));
         }

        const currentProduct = shopData.products[productIndex];
        // --- SAFETY CHECK --- Ensure stockItems exists and is an array
        if (!Array.isArray(currentProduct.stockItems)) {
            console.warn(`Product ${id} stockItems was not an array, initializing.`);
            currentProduct.stockItems = [];
        }
        const updatedStockItems = [...currentProduct.stockItems, ...itemsToAdd];

        // Update product fields
        currentProduct.name = name.trim();
        currentProduct.price = parsedPrice;
        currentProduct.category = category;
        currentProduct.description = description ? description.trim() : '';
        currentProduct.language = language ? language.trim() : '';
        currentProduct.version = version ? version.trim() : '';
        currentProduct.imageUrl = imageUrl.trim();
        currentProduct.stockItems = updatedStockItems;
        currentProduct.stock = updatedStockItems.length; // Update stock count
        currentProduct.updatedAt = new Date().toISOString();

        console.log(`Admin: Product data prepared for saving. ID: ${id}, Name: ${currentProduct.name}, Stock: ${currentProduct.stock}`);
        saveShopData(); // Save the updated shop data
        successMsg = `แก้ไขสินค้า "${currentProduct.name}" สำเร็จ. เพิ่มสต็อก ${itemsToAdd.length} ชิ้น. รวม ${currentProduct.stock} ชิ้น.`;
        console.log(`Admin: ${successMsg} (ID: ${id})`);
        res.redirect(`/admin/products?message=${encodeURIComponent(successMsg)}`); // Redirect on success
    } catch (error) {
        console.error(`Error editing product ${id}:`, error);
        errorMsg = `ผิดพลาดในการแก้ไข: ${error.message}`;
        res.redirect(`/admin/products?error=${encodeURIComponent(errorMsg)}`); // Redirect on error
    }
});
app.post('/admin/products/stock/delete/:productId/:itemIndex', (req, res) => {
    let errorMsg = '', successMsg = '';
    try {
        const { productId, itemIndex } = req.params;
        const index = parseInt(itemIndex, 10);

        const productIndex = shopData.products.findIndex(p => p.id === productId);
        if (productIndex === -1) throw new Error('ไม่พบสินค้า');

        const product = shopData.products[productIndex];
         if (!Array.isArray(product.stockItems)) product.stockItems = [];

        if (isNaN(index) || index < 0 || index >= product.stockItems.length) {
            throw new Error('ลำดับสต็อกไม่ถูกต้อง หรือไม่มีอยู่');
        }

        const removedItem = product.stockItems.splice(index, 1)[0];
        product.stock = product.stockItems.length;
        product.updatedAt = new Date().toISOString();
        saveShopData();

        successMsg = `ลบสต็อกลำดับที่ ${index + 1} ("${String(removedItem).substring(0, 15)}...") จากสินค้า ${product.name} สำเร็จ`;
        console.log(`Admin: ${successMsg}`);
        res.redirect(`/admin/products?message=${encodeURIComponent(successMsg)}`);
    } catch (error) {
        console.error(`Error deleting stock item for product ${req.params.productId}:`, error);
         errorMsg = `ผิดพลาด: ${error.message}`;
         res.redirect(`/admin/products?error=${encodeURIComponent(errorMsg)}`);
    }
});
app.post('/admin/products/delete/:id', (req, res) => {
     let errorMsg = '', successMsg = '';
    try {
        const { id } = req.params;
        const productIndex = shopData.products.findIndex(p => p.id === id);
        if (productIndex === -1) throw new Error('ไม่พบสินค้าที่ต้องการลบ');

        const productName = shopData.products[productIndex].name;
        shopData.products.splice(productIndex, 1);

        saveShopData();
        successMsg = `ลบสินค้า "${productName}" (ID: ${id}) เรียบร้อยแล้ว.`;
        console.log(`Admin: ${successMsg}`);
        res.redirect(`/admin/products?message=${encodeURIComponent(successMsg)}`);
    } catch (error) {
        console.error(`Error deleting product ${req.params.id}:`, error);
        errorMsg = `ผิดพลาด: ${error.message}`;
        res.redirect(`/admin/products?error=${encodeURIComponent(errorMsg)}`);
    }
});
// --- End Product Routes ---

// --- Category Routes ---
app.get('/admin/categories', (req, res) => {
    try {
        const categoriesWithCount = shopData.categories.map(cat => ({
            ...cat,
            productCount: shopData.products.filter(p => p.category === cat.name).length
        }));
        let message = req.query.message;
        let error = req.query.error;
        const categoryName = req.query.categoryName;

        if (error === 'delete_failed_in_use') {
            const catData = categoriesWithCount.find(c => c.name === decodeURIComponent(categoryName || ''));
            error = `ลบไม่สำเร็จ! ไม่สามารถลบหมวดหมู่ "${decodeURIComponent(categoryName || '')}" ได้เนื่องจากมีสินค้า (${catData?.productCount || '?'}) ใช้งานอยู่ กรุณาย้ายสินค้าออกก่อน`;
        }
        res.render('categories', { categories: categoriesWithCount, message, error, pageTitle: 'Categories' });
    } catch (error) {
        console.error("Error rendering categories page:", error);
        res.status(500).send("Error loading category data.");
    }
});
app.post('/admin/categories/add', (req, res) => {
    let errorMsg = '', successMsg = '';
    try {
        const { name, imageUrl, description } = req.body;
        if (!name || !name.trim()) throw new Error('ชื่อหมวดหมู่ห้ามว่าง');
        const trimmedName = name.trim();
        if (shopData.categories.some(cat => cat.name.toLowerCase() === trimmedName.toLowerCase())) {
            throw new Error(`หมวดหมู่ "${trimmedName}" มีอยู่แล้ว`);
        }
        if (imageUrl && !validateImageUrl(imageUrl)) throw new Error('รูปแบบ URL รูปภาพไม่ถูกต้อง');

        shopData.categories.push({
            name: trimmedName,
            imageUrl: imageUrl ? imageUrl.trim() : '',
            description: description ? description.trim() : ''
        });
        shopData.categories.sort((a, b) => a.name.localeCompare(b.name));
        saveShopData();
        successMsg = `เพิ่มหมวดหมู่ "${trimmedName}" สำเร็จ.`;
        console.log(`Admin: ${successMsg}`);
        res.redirect(`/admin/categories?message=${encodeURIComponent(successMsg)}`);
    } catch (error) {
        console.error("Error adding category:", error);
        errorMsg = `ผิดพลาด: ${error.message}`;
        res.redirect(`/admin/categories?error=${encodeURIComponent(errorMsg)}`);
    }
});
app.post('/admin/categories/edit', (req, res) => {
     let errorMsg = '', successMsg = '';
    try {
        const { originalName, newName, imageUrl, description } = req.body;
        if (!originalName) throw new Error('ไม่พบชื่อหมวดหมู่เดิม');
        if (!newName || !newName.trim()) throw new Error('ชื่อใหม่ห้ามว่าง');
        const trimmedNewName = newName.trim();

        if (trimmedNewName.toLowerCase() !== originalName.toLowerCase() &&
            shopData.categories.some(cat => cat.name.toLowerCase() === trimmedNewName.toLowerCase())) {
            throw new Error(`ชื่อหมวดหมู่ใหม่ "${trimmedNewName}" ซ้ำกับหมวดหมู่อื่น`);
        }
        if (imageUrl && !validateImageUrl(imageUrl)) throw new Error('รูปแบบ URL รูปภาพไม่ถูกต้อง');

        const categoryIndex = shopData.categories.findIndex(cat => cat.name === originalName);
        if (categoryIndex === -1) throw new Error('ไม่พบหมวดหมู่เดิมที่ต้องการแก้ไข');

        const oldName = shopData.categories[categoryIndex].name;
        shopData.categories[categoryIndex].name = trimmedNewName;
        shopData.categories[categoryIndex].imageUrl = imageUrl ? imageUrl.trim() : (shopData.categories[categoryIndex].imageUrl || '');
        shopData.categories[categoryIndex].description = description ? description.trim() : (shopData.categories[categoryIndex].description || '');

        let productsUpdated = 0;
        if (trimmedNewName !== oldName) {
            shopData.products.forEach(product => {
                if (product.category === oldName) {
                    product.category = trimmedNewName;
                    product.updatedAt = new Date().toISOString();
                    productsUpdated++;
                }
            });
             shopData.categories.sort((a, b) => a.name.localeCompare(b.name));
             console.log(`Admin: Renamed category "${oldName}" to "${trimmedNewName}", updated ${productsUpdated} products.`);
        } else {
             console.log(`Admin: Edited details for category "${trimmedNewName}" (name unchanged).`);
        }
        saveShopData();
        successMsg = `แก้ไขหมวดหมู่: "${oldName}" -> "${trimmedNewName}" สำเร็จ.${productsUpdated > 0 ? ' อัปเดต ' + productsUpdated + ' สินค้า.' : ''}`;
        res.redirect(`/admin/categories?message=${encodeURIComponent(successMsg)}`);
    } catch (error) {
        console.error("Error editing category:", error);
         errorMsg = `ผิดพลาด: ${error.message}`;
        res.redirect(`/admin/categories?error=${encodeURIComponent(errorMsg)}`);
    }
});
app.post('/admin/categories/delete/:name', (req, res) => {
     let errorMsg = '', successMsg = '';
    try {
        const decodedName = decodeURIComponent(req.params.name);
        const productsInCategory = shopData.products.filter(p => p.category === decodedName);
        if (productsInCategory.length > 0) {
            console.warn(`Admin: Attempted delete category "${decodedName}" with ${productsInCategory.length} products.`);
            return res.redirect(`/admin/categories?error=delete_failed_in_use&categoryName=${encodeURIComponent(decodedName)}`);
        }

        const initialLength = shopData.categories.length;
        shopData.categories = shopData.categories.filter(cat => cat.name !== decodedName);

        if (shopData.categories.length < initialLength) {
            saveShopData();
            successMsg = `ลบหมวดหมู่ "${decodedName}" สำเร็จ.`;
            console.log(`Admin: ${successMsg}`);
            res.redirect(`/admin/categories?message=${encodeURIComponent(successMsg)}`);
        } else {
             throw new Error('ไม่พบหมวดหมู่ที่ต้องการลบ');
        }
    } catch (error) {
        console.error(`Error deleting category ${decodeURIComponent(req.params.name)}:`, error);
         errorMsg = `ผิดพลาด: ${error.message}`;
         res.redirect(`/admin/categories?error=${encodeURIComponent(errorMsg)}`);
    }
});
// --- End Category Routes ---

// --- Order Routes ---
app.get('/admin/orders', (req, res) => {
    try {
        const sortedOrders = [...shopData.orders]
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        res.render('orders', {
             orders: sortedOrders,
             message: req.query.message,
             error: req.query.error,
             pageTitle: 'Orders'
        });
    } catch (error) {
        console.error("Error rendering orders page:", error);
        res.status(500).send("Error loading order data.");
    }
});
app.post('/admin/orders/status/:id', (req, res) => {
     let errorMsg = '', successMsg = '';
    try {
        const { id } = req.params;
        const { status } = req.body;
        const validStatuses = ['pending', 'completed', 'cancelled', 'processing', 'shipped', 'refunded'];
        if (!status || !validStatuses.includes(status)) throw new Error('สถานะไม่ถูกต้อง');

        const orderIndex = shopData.orders.findIndex(o => o.id === id);
        if (orderIndex === -1) throw new Error('ไม่พบคำสั่งซื้อ');

        if (shopData.orders[orderIndex].status !== status) {
            shopData.orders[orderIndex].status = status;
            shopData.orders[orderIndex].updatedAt = new Date().toISOString();
            saveShopData();
            successMsg = `อัปเดตสถานะคำสั่งซื้อ ${id} เป็น ${status} สำเร็จ`;
            console.log(`Admin: ${successMsg}`);
            res.redirect(`/admin/orders?message=${encodeURIComponent(successMsg)}#order-${id}`);
        } else {
             res.redirect(`/admin/orders#order-${id}`);
        }
    } catch (error) {
        console.error(`Error updating order status ${req.params.id}:`, error);
        errorMsg = `ผิดพลาด: ${error.message}`;
        res.redirect(`/admin/orders?error=${encodeURIComponent(errorMsg)}`);
    }
});
app.post('/admin/orders/delete/:id', (req, res) => {
    let errorMsg = '', successMsg = '';
    try {
        const { id } = req.params;
        const initialLength = shopData.orders.length;
        shopData.orders = shopData.orders.filter(o => o.id !== id);

        if (shopData.orders.length < initialLength) {
            saveShopData();
            successMsg = `ลบคำสั่งซื้อ ${id} สำเร็จ.`;
            console.log(`Admin: ${successMsg}`);
            res.redirect(`/admin/orders?message=${encodeURIComponent(successMsg)}`);
        } else {
            throw new Error('ไม่พบคำสั่งซื้อที่ต้องการลบ.');
        }
    } catch (error) {
        console.error(`Error deleting order ${req.params.id}:`, error);
        errorMsg = `ผิดพลาด: ${error.message}`;
        res.redirect(`/admin/orders?error=${encodeURIComponent(errorMsg)}`);
    }
});
// --- End Order Routes ---

// --- Redemption Code Routes ---
app.get('/admin/codes', (req, res) => {
    try {
        const sortedCodes = [...validRedemptionCodes].sort();
        res.render('codes', {
             codes: sortedCodes,
             message: req.query.message,
             error: req.query.error,
             pageTitle: 'Redemption Codes'
         });
    } catch (error) {
        console.error("Error rendering codes page:", error);
        res.status(500).send("Error loading codes data.");
    }
});
app.post('/admin/codes/add', (req, res) => {
    try {
        let { code, count } = req.body;
        count = parseInt(count, 10) || 0;
        const CODE_LENGTH = 32;
        const CODE_PATTERN = /^[A-Z0-9]{32}$/;
        let addedCount = 0;
        let skippedCount = 0;
        let message = '', error = '';
        const addedCodesList = [];

        if (code && code.trim()) {
            code = code.trim().toUpperCase();
            if (code.length !== CODE_LENGTH || !CODE_PATTERN.test(code)) {
                error = `ผิดพลาด: โค้ดที่ใส่เองต้องเป็น ${CODE_LENGTH} ตัวอักษร (A-Z, 0-9).`;
            } else if (validRedemptionCodes.some(c => c.toUpperCase() === code)) {
                error = `ผิดพลาด: โค้ด "${code}" มีอยู่แล้ว`;
            } else {
                validRedemptionCodes.push(code);
                addedCodesList.push(code);
                addedCount++;
            }
        }
        else if (count > 0 && addedCount === 0) {
            if (count > 1000) {
                 console.warn("Limiting code generation to 1000.");
                 count = 1000;
            }

            let generatedCodes = new Set();
            let existingCodesUpper = new Set(validRedemptionCodes.map(c => c.toUpperCase()));

             while(generatedCodes.size < count) {
                 let attempts = 0;
                 let generatedCode;
                 const maxAttempts = 30;

                 do {
                     generatedCode = crypto.randomBytes(16).toString('hex').toUpperCase();
                     attempts++;
                 } while ((existingCodesUpper.has(generatedCode) || generatedCodes.has(generatedCode)) && attempts < maxAttempts);

                 if (attempts < maxAttempts) {
                      generatedCodes.add(generatedCode);
                  } else {
                      console.warn(`Failed to generate unique code after ${maxAttempts} attempts. Stopping generation. Generated: ${generatedCodes.size}/${count}`);
                      skippedCount = count - generatedCodes.size;
                      break;
                  }
             }
             if (generatedCodes.size > 0) {
                 const codesToAdd = Array.from(generatedCodes);
                 validRedemptionCodes.push(...codesToAdd);
                 addedCodesList.push(...codesToAdd);
                 addedCount += generatedCodes.size;
             }
        } else if (addedCount === 0 && count <= 0) {
             error = "กรุณาใส่โค้ดเอง หรือระบุจำนวนที่ต้องการสร้าง (> 0)";
        }

        if (addedCount > 0) {
            validRedemptionCodes.sort();
            saveValidRedemptionCodes();
            console.log(`Admin: Added ${addedCount} redemption code(s).`);
            message = `เพิ่ม/สร้างโค้ดสำเร็จ ${addedCount} โค้ด.`;
            if (skippedCount > 0) message += ` ข้าม ${skippedCount} โค้ด (อาจเกิดจากชนกัน).`;
            if (error) message += ` หมายเหตุ: ${error}`;
            res.redirect(`/admin/codes?message=${encodeURIComponent(message)}`);
        } else {
             if (!error) error = "ไม่ได้เพิ่มโค้ด (โปรดตรวจสอบข้อมูล)";
             res.redirect(`/admin/codes?error=${encodeURIComponent(error)}`);
        }
    } catch (err) {
        console.error("Error adding/generating codes:", err);
        res.redirect(`/admin/codes?error=${encodeURIComponent('ผิดพลาด: ' + err.message)}`);
    }
});
app.post('/admin/codes/delete/:code', (req, res) => {
    try {
        const codeToDelete = req.params.code?.toUpperCase();
        if (!codeToDelete || !/^[A-Z0-9]{32}$/.test(codeToDelete)) {
             throw new Error('รูปแบบโค้ดไม่ถูกต้อง');
        }
        const initialLength = validRedemptionCodes.length;
        validRedemptionCodes = validRedemptionCodes.filter(c => c.toUpperCase() !== codeToDelete);

        if (validRedemptionCodes.length < initialLength) {
            saveValidRedemptionCodes();
            console.log(`Admin: Code deleted - ${codeToDelete}`);
            res.redirect('/admin/codes?message=' + encodeURIComponent(`ลบโค้ด "${codeToDelete}" สำเร็จ.`));
        } else {
             throw new Error(`ไม่พบโค้ด "${codeToDelete}"`);
        }
    } catch (error) {
        console.error(`Error deleting code ${req.params.code}:`, error);
        res.redirect(`/admin/codes?error=${encodeURIComponent('ผิดพลาด: ' + error.message)}`);
    }
});
// --- End Redemption Code Routes ---

// --- Discount Code Routes ---
app.get('/admin/discounts', (req, res) => {
     try {
        const sortedDiscounts = [...discountCodes]
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        res.render('discounts', {
             discounts: sortedDiscounts,
             message: req.query.message,
             error: req.query.error,
             pageTitle: 'Discount Codes'
        });
     } catch (error) {
         console.error("Error rendering discounts page:", error);
         res.status(500).send("Error loading discount code data.");
     }
});
app.post('/admin/discounts/add', (req, res) => {
    try {
        let { code, type, value, maxUses, minPurchase, expiresAt } = req.body;
        let errors = [];

        code = code ? code.trim().toUpperCase() : '';
        if (!code || !/^[A-Z0-9]{3,20}$/.test(code)) {
            errors.push('รูปแบบโค้ดไม่ถูกต้อง (3-20 ตัว A-Z, 0-9)');
        } else if (discountCodes.some(dc => dc.code === code)) {
            errors.push(`โค้ดส่วนลด "${code}" มีอยู่แล้ว`);
        }
        if (type !== 'percentage' && type !== 'fixed') {
             errors.push('ประเภทส่วนลดไม่ถูกต้อง');
        }

        value = parseFloat(value);
        if (isNaN(value) || value <= 0) errors.push('มูลค่าส่วนลดต้องเป็นบวก');
        else if (type === 'percentage' && value > 100) errors.push('ส่วนลดเปอร์เซ็นต์ห้ามเกิน 100%');

        maxUses = maxUses ? (parseInt(maxUses, 10) || null) : null;
        if (maxUses !== null && maxUses < 1) errors.push('จำนวนครั้งสูงสุดต้อง >= 1 (หรือเว้นว่าง)');

        minPurchase = minPurchase ? (parseFloat(minPurchase) || 0) : 0;
        if (minPurchase < 0) errors.push('ยอดซื้อขั้นต่ำห้ามติดลบ');

        let expiryDate = null;
        if (expiresAt) {
            try {
                 const d = new Date(expiresAt);
                 if (isNaN(d.getTime())) throw new Error('Invalid date value');
                 const localDate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
                 expiryDate = localDate.toISOString();
                 console.log(`Setting expiry for ${code} to ${expiryDate} (from input ${expiresAt})`);
            } catch {
                errors.push('รูปแบบวันหมดอายุไม่ถูกต้อง');
            }
        }

        if (errors.length > 0) {
             return res.redirect(`/admin/discounts?error=${encodeURIComponent(errors.join(', '))}`);
        }

        const newDiscount = {
             id: `DC-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
             code: code,
             type: type,
             value: value,
             maxUses: maxUses,
             uses: 0,
             minPurchase: minPurchase,
             expiresAt: expiryDate,
             createdAt: new Date().toISOString()
        };

        discountCodes.push(newDiscount);
        saveDiscountCodes();
        console.log(`Admin: Discount code added - ${newDiscount.code}`);
        let message = `เพิ่มโค้ดส่วนลด "${newDiscount.code}" สำเร็จ.`;
        res.redirect(`/admin/discounts?message=${encodeURIComponent(message)}`);

    } catch (err) {
        console.error("Error adding discount code:", err);
        res.redirect(`/admin/discounts?error=${encodeURIComponent('ผิดพลาด: ' + err.message)}`);
    }
});
app.post('/admin/discounts/edit/:id', (req, res) => {
     try {
         const { id } = req.params;
         let { code, type, value, maxUses, minPurchase, expiresAt } = req.body;
         let errors = [];

         const discountIndex = discountCodes.findIndex(dc => dc.id === id);
         if (discountIndex === -1) {
             return res.status(404).send('ไม่พบโค้ดส่วนลดที่ต้องการแก้ไข');
         }

         code = code ? code.trim().toUpperCase() : '';
         if (!code || !/^[A-Z0-9]{3,20}$/.test(code)) {
            errors.push('รูปแบบโค้ดไม่ถูกต้อง (3-20 ตัว A-Z, 0-9)');
         } else if (discountCodes.some(dc => dc.code === code && dc.id !== id)) {
             errors.push(`โค้ดส่วนลด "${code}" ซ้ำกับโค้ดอื่น`);
         }
         if (type !== 'percentage' && type !== 'fixed') {
             errors.push('ประเภทส่วนลดไม่ถูกต้อง');
         }

         value = parseFloat(value);
         if (isNaN(value) || value <= 0) errors.push('มูลค่าส่วนลดต้องเป็นบวก');
         else if (type === 'percentage' && value > 100) errors.push('ส่วนลดเปอร์เซ็นต์ห้ามเกิน 100%');

          maxUses = maxUses ? (parseInt(maxUses, 10) || null) : null;
          if (maxUses !== null && maxUses < 1) errors.push('จำนวนครั้งสูงสุดต้อง >= 1 (หรือเว้นว่าง)');

          minPurchase = minPurchase ? (parseFloat(minPurchase) || 0) : 0;
          if (minPurchase < 0) errors.push('ยอดซื้อขั้นต่ำห้ามติดลบ');

         let expiryDate = null;
          if (expiresAt) {
             try {
                  const d = new Date(expiresAt);
                  if (isNaN(d.getTime())) throw new Error('Invalid date value');
                  const localDate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
                  expiryDate = localDate.toISOString();
                  console.log(`Setting expiry for ${code} (edit) to ${expiryDate} (from input ${expiresAt})`);
             } catch {
                 errors.push('รูปแบบวันหมดอายุไม่ถูกต้อง');
             }
          }

         if (errors.length > 0) {
              return res.redirect(`/admin/discounts?error=${encodeURIComponent(errors.join(', '))}`);
         }

         const currentDiscount = discountCodes[discountIndex];
         const currentUses = currentDiscount.uses || 0;

          if (maxUses !== null && maxUses < currentUses) {
              return res.redirect(`/admin/discounts?error=${encodeURIComponent(`ไม่สามารถลดจำนวนครั้งสูงสุด (${maxUses}) ให้น้อยกว่าที่ใช้ไปแล้ว (${currentUses})`)}`);
          }

         currentDiscount.code = code;
         currentDiscount.type = type;
         currentDiscount.value = value;
         currentDiscount.maxUses = maxUses;
         currentDiscount.minPurchase = minPurchase;
         currentDiscount.expiresAt = expiryDate;
         currentDiscount.uses = currentUses; // Ensure uses count is preserved

         saveDiscountCodes();
         console.log(`Admin: Discount code edited - ${currentDiscount.code} (ID: ${id})`);
         let message = `แก้ไขโค้ดส่วนลด "${currentDiscount.code}" สำเร็จ.`;
         res.redirect(`/admin/discounts?message=${encodeURIComponent(message)}`);

     } catch (err) {
         console.error(`Error editing discount code ${req.params.id}:`, err);
         res.redirect(`/admin/discounts?error=${encodeURIComponent('ผิดพลาด: ' + err.message)}`);
     }
});
app.post('/admin/discounts/delete/:id', (req, res) => {
     try {
         const { id } = req.params;
         const initialLength = discountCodes.length;
         const codeToDelete = discountCodes.find(dc => dc.id === id)?.code;

         discountCodes = discountCodes.filter(dc => dc.id !== id);

         if (discountCodes.length < initialLength) {
             saveDiscountCodes();
             console.log(`Admin: Discount code deleted - ID ${id} (Code: ${codeToDelete || 'N/A'})`);
             res.redirect('/admin/discounts?message=' + encodeURIComponent(`ลบโค้ดส่วนลด "${codeToDelete || id}" สำเร็จ.`));
         } else {
              throw new Error(`ไม่พบโค้ดส่วนลด ID "${id}"`);
         }
     } catch (error) {
         console.error(`Error deleting discount code ${req.params.id}:`, error);
         res.redirect(`/admin/discounts?error=${encodeURIComponent('ผิดพลาด: ' + error.message)}`);
     }
});
// --- End Discount Code Routes ---

// --- End Admin ---

// --- EJS Template Creation and File Checks ---
// Templates are included within the JS file itself for easier distribution.
const templates = {
    'navbar.ejs': `
<nav class="navbar navbar-expand-lg navbar-dark bg-dark fixed-top shadow-sm">
  <div class="container">
    <a class="navbar-brand" href="/admin"><i class="bi bi-shield-lock-fill"></i> Admin Panel</a>
    <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNavAdmin" aria-controls="navbarNavAdmin" aria-expanded="false" aria-label="Toggle navigation">
      <span class="navbar-toggler-icon"></span>
    </button>
    <div class="collapse navbar-collapse" id="navbarNavAdmin">
      <ul class="navbar-nav ms-auto mb-2 mb-lg-0">
        <li class="nav-item">
          <a class="nav-link <%= (pageTitle === 'Dashboard') ? 'active' : '' %>" href="/admin"><i class="bi bi-speedometer2"></i> แดชบอร์ด</a>
        </li>
        <li class="nav-item">
          <a class="nav-link <%= (pageTitle === 'Products') ? 'active' : '' %>" href="/admin/products"><i class="bi bi-box-seam"></i> สินค้า</a>
        </li>
        <li class="nav-item">
          <a class="nav-link <%= (pageTitle === 'Categories') ? 'active' : '' %>" href="/admin/categories"><i class="bi bi-tags-fill"></i> หมวดหมู่</a>
        </li>
        <li class="nav-item">
          <a class="nav-link <%= (pageTitle === 'Orders') ? 'active' : '' %>" href="/admin/orders"><i class="bi bi-receipt-cutoff"></i> คำสั่งซื้อ</a>
        </li>
         <li class="nav-item">
          <a class="nav-link <%= (pageTitle === 'Discount Codes') ? 'active' : '' %>" href="/admin/discounts"><i class="bi bi-percent"></i> ส่วนลด</a>
        </li>
        <li class="nav-item">
          <a class="nav-link <%= (pageTitle === 'Redemption Codes') ? 'active' : '' %>" href="/admin/codes"><i class="bi bi-key-fill"></i> โค้ดรับของ</a>
        </li>
        <li class="nav-item">
          <a class="nav-link <%= (pageTitle === 'Settings') ? 'active' : '' %>" href="/admin/settings"><i class="bi bi-gear-wide-connected"></i> ตั้งค่า</a>
        </li>
      </ul>
    </div>
  </div>
</nav>
`,
    'dashboard.ejs': `
<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>แดชบอร์ด - Admin</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"><style>.card-icon{font-size:2.5rem}.card{transition:transform .2s ease-in-out}.card:hover{transform:translateY(-5px);box-shadow:0 4px 8px rgba(0,0,0,.1)}body{padding-top:70px;background-color:#f8f9fa}.card-footer span{margin-right:auto}.table th,.table td{vertical-align:middle}</style></head><body><%- include('navbar', { pageTitle: 'Dashboard' }) %><div class="container mt-4"><h2 class="mb-4"><i class="bi bi-speedometer2"></i> แดชบอร์ดภาพรวม</h2><div class="row g-4 mb-4"><div class="col-xl-2dot4 col-md-4 col-sm-6"><div class="card text-white bg-primary h-100"><div class="card-body d-flex justify-content-between align-items-center"><div><h5 class="card-title">สินค้า</h5><h2 class="card-text display-6"><%= stats.totalProducts %></h2></div><i class="bi bi-box-seam card-icon opacity-75"></i></div><a href="/admin/products" class="card-footer text-white text-decoration-none d-flex justify-content-between align-items-center"><span>จัดการสินค้า</span> <i class="bi bi-arrow-right-circle"></i></a></div></div><div class="col-xl-2dot4 col-md-4 col-sm-6"><div class="card text-white bg-info h-100"><div class="card-body d-flex justify-content-between align-items-center"><div><h5 class="card-title">หมวดหมู่</h5><h2 class="card-text display-6"><%= stats.totalCategories %></h2></div><i class="bi bi-tags card-icon opacity-75"></i></div><a href="/admin/categories" class="card-footer text-white text-decoration-none d-flex justify-content-between align-items-center"><span>จัดการหมวดหมู่</span> <i class="bi bi-arrow-right-circle"></i></a></div></div><div class="col-xl-2dot4 col-md-4 col-sm-6"><div class="card text-white bg-success h-100"><div class="card-body d-flex justify-content-between align-items-center"><div><h5 class="card-title">คำสั่งซื้อสำเร็จ</h5><h2 class="card-text display-6"><%= stats.completedOrders %> <small>/ <%= stats.totalOrders %></small></h2></div><i class="bi bi-cart-check card-icon opacity-75"></i></div><a href="/admin/orders" class="card-footer text-white text-decoration-none d-flex justify-content-between align-items-center"><span>ดูคำสั่งซื้อ</span> <i class="bi bi-arrow-right-circle"></i></a></div></div><div class="col-xl-2dot4 col-md-6 col-sm-6"><div class="card text-dark bg-warning h-100"><div class="card-body d-flex justify-content-between align-items-center"><div><h5 class="card-title">รายรับรวม</h5><h3 class="card-text">฿<%= stats.totalRevenue %></h3><small>(หลังหักส่วนลด)</small></div><i class="bi bi-currency-bitcoin card-icon opacity-75"></i></div><div class="card-footer text-dark"><small>ยอดส่วนลดรวม: ฿<%= stats.totalDiscountsGiven %></small></div></div></div><div class="col-xl-2dot4 col-md-6 col-sm-12"><div class="card text-white bg-secondary h-100"><div class="card-body d-flex justify-content-between align-items-center"><div><h5 class="card-title">ส่วนลดใช้งาน</h5><h2 class="card-text display-6"><%= stats.activeDiscountCodes %></h2></div><i class="bi bi-percent card-icon opacity-75"></i></div><a href="/admin/discounts" class="card-footer text-white text-decoration-none d-flex justify-content-between align-items-center"><span>จัดการส่วนลด</span> <i class="bi bi-arrow-right-circle"></i></a></div></div></div><!-- Auto Promotion Status --><div class="alert alert-primary" role="alert"><i class="bi bi-megaphone-fill"></i> <strong>สถานะโปรโมชั่นอัตโนมัติ:</strong> <%= stats.autoPromotionStatus %> <a href="/admin/settings" class="alert-link ms-2">(แก้ไข)</a></div><div class="card mt-4"><div class="card-header bg-light"><h4><i class="bi bi-clock-history"></i> คำสั่งซื้อล่าสุด (5 รายการ)</h4></div><div class="card-body p-0"><div class="table-responsive"><table class="table table-striped table-hover mb-0"><thead class="table-light"><tr><th>รหัส</th><th>ลูกค้า</th><th>ยอดรวม (ส่วนลด)</th><th>ช่องทาง</th><th>สถานะ</th><th>วันที่</th></tr></thead><tbody><% if(stats.recentOrders.length > 0){ %><% stats.recentOrders.forEach(order => { const finalAmount = order.finalAmount !== undefined ? order.finalAmount : ((order.originalTotalAmount || 0) - (order.discountAmount || 0)); %><tr><td><a href="/admin/orders#order-<%= order.id %>" title="<%= order.id %>"><%= order.id.slice(0,12) %>...</a></td><td><span title="<%= order.userId %>"><%= order.userId.slice(0,6) %>...<%= order.userId.slice(-4) %></span></td><td>฿<%= finalAmount.toFixed(2) %><% if (order.discountAmount && order.discountAmount > 0) { %><br><small class="text-danger" title="Code: <%= order.discountCode || 'N/A' %>">(-฿<%= order.discountAmount.toFixed(2) %><% if (order.discountCode === 'AUTO_PROMO') { %> <i class="bi bi-stars text-warning" title="โปรโมชั่นอัตโนมัติ"></i><% } %>)</small><% } %></td><td><span class="badge bg-<%= order.paymentMethod==='angpao'?'danger':order.paymentMethod==='bank'?'info':order.paymentMethod==='redeem_code'?'primary':'secondary' %> text-capitalize"><i class="bi bi-<%= order.paymentMethod==='angpao'?'gift':order.paymentMethod==='bank'?'bank':order.paymentMethod==='redeem_code'?'key':'question-circle' %>"></i> <%= order.paymentMethod || 'N/A' %></span></td><td><span class="badge bg-<%= order.status === 'completed' ? 'success' : (order.status === 'cancelled' || order.status === 'refunded' ? 'danger' : (order.status === 'pending' ? 'warning' : 'secondary')) %> text-capitalize"><%= order.status || 'N/A' %></span></td><td><%= new Date(order.createdAt || Date.now()).toLocaleString('th-TH', {dateStyle:'short', timeStyle:'short'}) %></td></tr><% }) %><% } else { %><tr><td colspan="6" class="text-center text-muted py-3">ยังไม่มีคำสั่งซื้อ</td></tr><% } %></tbody></table></div></div><div class="card-footer text-end bg-light border-top-0"><a href="/admin/orders" class="btn btn-outline-primary btn-sm">ดูคำสั่งซื้อทั้งหมด <i class="bi bi-arrow-right"></i></a></div></div></div><script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script><style>.col-xl-2dot4 { flex: 0 0 auto; width: 20%; } @media (max-width: 1200px) { .col-xl-2dot4 { width: 33.333%; } } @media (max-width: 768px) { .col-xl-2dot4 { width: 50%; } } @media (max-width: 576px) { .col-xl-2dot4 { width: 100%; } }</style></body></html>
`,
    'products.ejs': `
<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>จัดการสินค้า - Admin</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"><style>.product-image-thumb{width:60px;height:60px;object-fit:cover;border-radius:4px}.image-preview{max-width:150px;max-height:100px;margin-top:10px;display:none;border:1px solid #ddd;padding:2px;border-radius:4px}th,td{vertical-align:middle}body{padding-top:70px;background-color:#f8f9fa}.btn-action form{display:inline}.stock-items-display{font-size:.8rem;color:#6c757d;max-height:60px;overflow-y:auto;display:block;white-space:pre-wrap;word-break:break-all}.stock-item-delete-btn{font-size:.7rem;padding:.1rem .3rem;line-height:1}.modal-xl{max-width:1000px}</style></head><body><%- include('navbar', { pageTitle: 'Products' }) %><div class="container mt-4"><div class="d-flex justify-content-between align-items-center mb-3"><h2><i class="bi bi-box-seam"></i> จัดการสินค้า (<%= products.length %> รายการ)</h2><button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addProductModal"><i class="bi bi-plus-circle"></i> เพิ่มสินค้า</button></div><!-- Display Messages/Errors --><% if (typeof message !== 'undefined' && message) { %><div class="alert alert-success alert-dismissible fade show" role="alert"><i class="bi bi-check-circle-fill"></i> <%= message %><button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div><% } %><% if (typeof error !== 'undefined' && error) { %><div class="alert alert-danger alert-dismissible fade show" role="alert"><i class="bi bi-exclamation-triangle-fill"></i> <%= error %><button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div><% } %><div class="card shadow-sm"><div class="card-body p-0"><div class="table-responsive"><table class="table table-striped table-hover mb-0"><thead class="table-light"><tr><th>รูป</th><th>ชื่อ</th><th>ราคา (฿)</th><th>คงเหลือ</th><th>หมวดหมู่</th><th>วันที่เพิ่ม/แก้ไข</th><th class="text-center">จัดการ</th></tr></thead><tbody><% if(products.length > 0){ %><% products.forEach(product => { const modalId = "editProductModal" + product.id.replace(/[^a-zA-Z0-9]/g, ''); %><tr><td><img src="<%= product.imageUrl %>" alt="Img" class="product-image-thumb" onerror="this.onerror=null; this.src='https://via.placeholder.com/60/dee2e6/6c757d?text=Err';"></td><td><%= product.name %><br><small class="text-muted">ID: <%= product.id.substring(0, 10) %>...</small></td><td><%= product.price.toFixed(2) %></td><td><span class="badge fs-6 bg-<%= product.stock > 5 ? 'success' : (product.stock > 0 ? 'warning' : 'danger') %>" title="คลิกเพื่อแก้ไขสต็อก" data-bs-toggle="modal" data-bs-target="#<%= modalId %>" style="cursor:pointer;"><%= product.stock %></span></td><td><small><%= product.category %></small></td><td><small title="Created: <%= new Date(product.createdAt || 0).toLocaleString('th-TH') %>\nUpdated: <%= new Date(product.updatedAt || 0).toLocaleString('th-TH') %>"><%= new Date(product.updatedAt || product.createdAt || 0).toLocaleDateString('th-TH', { year:'2-digit', month:'short', day:'numeric'}) %></small></td><td class="text-center btn-action"><button class="btn btn-sm btn-warning me-1" data-bs-toggle="modal" data-bs-target="#<%= modalId %>" title="แก้ไข"><i class="bi bi-pencil-square"></i></button><form method="POST" action="/admin/products/delete/<%= product.id %>" class="d-inline"><button type="submit" class="btn btn-sm btn-danger" onclick="return confirm('ยืนยันลบสินค้า: <%= product.name %> ?')" title="ลบ"><i class="bi bi-trash3"></i></button></form></td></tr><% }) %><% } else { %><tr><td colspan="7" class="text-center text-muted py-3">ยังไม่มีสินค้าในระบบ</td></tr><% } %></tbody></table></div></div></div></div><!-- Add Product Modal --><div class="modal fade" id="addProductModal" tabindex="-1" aria-hidden="true"><div class="modal-dialog modal-lg"><div class="modal-content"><form method="POST" action="/admin/products/add"><div class="modal-header"><h5 class="modal-title">เพิ่มสินค้าใหม่</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body"><div class="row"><div class="col-md-8 mb-3"><label class="form-label">ชื่อสินค้า*</label><input type="text" name="name" class="form-control" required></div><div class="col-md-4 mb-3"><label class="form-label">ราคา (฿)*</label><input type="number" name="price" class="form-control" step="0.01" min="0" required></div></div><div class="mb-3"><label class="form-label">หมวดหมู่*</label><select name="category" class="form-select" required><option value="" disabled <%= categories.length === 0 ? '' : 'selected' %>>-- เลือก --</option><% categories.forEach(c => { %><option value="<%= c.name %>"><%= c.name %></option><% }) %><% if(categories.length === 0){ %><option disabled>!! กรุณาเพิ่มหมวดหมู่ก่อน !!</option><% } %></select></div><div class="mb-3"><label class="form-label">รายละเอียด</label><textarea name="description" class="form-control" rows="2"></textarea></div><div class="row"><div class="col-md-6 mb-3"><label class="form-label">ภาษา</label><input type="text" name="language" class="form-control"></div><div class="col-md-6 mb-3"><label class="form-label">เวอร์ชัน</label><input type="text" name="version" class="form-control"></div></div><div class="mb-3"><label class="form-label">URL รูปภาพ*</label><input type="url" name="imageUrl" class="form-control image-url-input" required placeholder="https://..."><img src="" class="image-preview"><div class="form-text text-muted">ต้องเป็น https:// และลงท้ายด้วย .jpg, .png, .gif, .webp</div></div><div class="mb-3"><label class="form-label">ข้อมูลสต็อกสินค้า (Stock Items)*</label><textarea name="stockItemsInput" class="form-control" required rows="5" placeholder="ใส่ข้อมูลที่จะส่งให้ลูกค้า 1 รายการ ต่อ 1 บรรทัด (เช่น โค้ด, ลิงก์ดาวน์โหลด)"></textarea><div class="form-text">จำนวนบรรทัด = จำนวนสต็อกเริ่มต้น. ห้ามเว้นบรรทัดว่าง.</div></div></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button><button type="submit" class="btn btn-primary" <%= categories.length === 0 ? 'disabled' : '' %>>บันทึกสินค้า</button></div></form></div></div></div><!-- Edit Product Modals --><% products.forEach(product => { const modalId = "editProductModal" + product.id.replace(/[^a-zA-Z0-9]/g, ''); %><div class="modal fade" id="<%= modalId %>" tabindex="-1" aria-hidden="true"><div class="modal-dialog modal-xl"><div class="modal-content"><form method="POST" action="/admin/products/edit/<%= product.id %>"><div class="modal-header"><h5 class="modal-title">แก้ไขสินค้า: <%= product.name %></h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body"><div class="row"><div class="col-lg-7"><div class="row"><div class="col-md-8 mb-3"><label class="form-label">ชื่อ*</label><input type="text" name="name" class="form-control" value="<%= product.name %>" required></div><div class="col-md-4 mb-3"><label class="form-label">ราคา*</label><input type="number" name="price" class="form-control" step="0.01" min="0" value="<%= product.price %>" required></div></div><div class="mb-3"><label class="form-label">หมวดหมู่*</label><select name="category" class="form-select" required><% categories.forEach(c => { %><option value="<%= c.name %>" <%= c.name === product.category ? 'selected' : '' %>><%= c.name %></option><% }) %><% if(categories.length === 0){ %><option disabled>!! ไม่มีหมวดหมู่ !!</option><% } %></select></div><div class="mb-3"><label class="form-label">รายละเอียด</label><textarea name="description" class="form-control" rows="2"><%= product.description %></textarea></div><div class="row"><div class="col-md-6 mb-3"><label class="form-label">ภาษา</label><input type="text" name="language" class="form-control" value="<%= product.language || '' %>"></div><div class="col-md-6 mb-3"><label class="form-label">เวอร์ชัน</label><input type="text" name="version" class="form-control" value="<%= product.version || '' %>"></div></div><div class="mb-3"><label class="form-label">URL รูปภาพ*</label><input type="url" name="imageUrl" class="form-control image-url-input" value="<%= product.imageUrl %>" required><img src="<%= product.imageUrl %>" class="image-preview" style="display:block;" onerror="this.style.display='none';"><div class="form-text text-muted">ต้องเป็น https:// และลงท้ายด้วย .jpg, .png, .gif, .webp</div></div></div><div class="col-lg-5"><div class="mb-3"><label class="form-label">รายการสต็อกปัจจุบัน (<%= product.stockItems ? product.stockItems.length : 0 %> รายการ)</label><div class="border rounded p-2 bg-light stock-items-display" style="max-height: 150px; overflow-y: auto;"><% if (Array.isArray(product.stockItems) && product.stockItems.length > 0) { %><ul class="list-unstyled mb-0"><% product.stockItems.forEach((item, index) => { %><li class="d-flex justify-content-between align-items-center mb-1"><small class="me-2 text-truncate" title="<%= item %>"><%= index + 1 %>. <%= item %></small><form method="POST" action="/admin/products/stock/delete/<%= product.id %>/<%= index %>" class="d-inline" onsubmit="return confirm('ยืนยันลบสต็อกรายการที่ <%= index + 1 %> ?')"><button type="submit" class="btn btn-outline-danger btn-sm stock-item-delete-btn" title="ลบรายการนี้"><i class="bi bi-x-lg"></i></button></form></li><% }) %></ul><% } else { %><span class="text-muted">ไม่มีสต็อก</span><% } %></div></div><hr><div class="mb-3"><label class="form-label">เพิ่มสต็อก (Stock Items)</label><textarea name="stockItemsToAdd" class="form-control" rows="4" placeholder="ใส่ข้อมูลสต็อกที่จะเพิ่ม 1 รายการ ต่อ 1 บรรทัด"></textarea><div class="form-text">ข้อมูลที่เพิ่มจะต่อท้ายรายการเดิม. ห้ามเว้นบรรทัดว่าง.</div></div></div></div></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button><button type="submit" class="btn btn-primary">บันทึกการเปลี่ยนแปลง</button></div></form></div></div></div><% }) %><script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script><script>document.addEventListener('DOMContentLoaded',function(){const t=e=>{const o=e.querySelector('.image-url-input'),n=e.querySelector('.image-preview');if(!o||!n)return;const i=()=>{const t=o.value.trim(),l=/^(https?:\/\/).+\.(jpg|jpeg|png|gif|webp)([\?#].*)?$/i.test(t);l?(n.src=t,n.style.display='block',o.classList.remove('is-invalid'),n.onerror=()=>{n.style.display='none';o.classList.add('is-invalid')}) : (n.style.display='none',n.src='',t?o.classList.add('is-invalid'):o.classList.remove('is-invalid'))};o.addEventListener('input',i),o.dispatchEvent(new Event('input'))};document.querySelectorAll('.modal').forEach(t);const e=document.querySelector('.alert-success'),o=document.querySelector('.alert-danger');e&&setTimeout(()=>{try{new bootstrap.Alert(e).close()}catch(t){}},7e3),o&&setTimeout(()=>{try{new bootstrap.Alert(o).close()}catch(t){}},1e4)});</script></body></html>
`,
    'categories.ejs': `
<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>จัดการหมวดหมู่ - Admin</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"><style>.category-image-thumb{width:50px;height:50px;object-fit:cover;border-radius:4px;margin-right:10px;background-color:#eee}th,td{vertical-align:middle}.alert-tooltip{cursor:help}body{padding-top:70px;background-color:#f8f9fa}.btn-action form{display:inline}.image-preview{max-width:100px;max-height:80px;margin-top:5px;display:none;border:1px solid #ddd;padding:2px;border-radius:4px}</style></head><body><%- include('navbar', { pageTitle: 'Categories' }) %><div class="container mt-4"><div class="d-flex justify-content-between align-items-center mb-3"><h2><i class="bi bi-tags-fill"></i> จัดการหมวดหมู่ (<%= categories.length %> รายการ)</h2><button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addCategoryModal"><i class="bi bi-plus-circle"></i> เพิ่มหมวดหมู่</button></div><!-- Display Messages/Errors --><% if (typeof message !== 'undefined' && message) { %><div class="alert alert-success alert-dismissible fade show" role="alert"><i class="bi bi-check-circle-fill"></i> <%= message %><button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div><% } %><% if (typeof error !== 'undefined' && error) { %><div class="alert alert-danger alert-dismissible fade show" role="alert"><i class="bi bi-exclamation-triangle-fill"></i> <%= error %><button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div><% } %><div class="card shadow-sm"><div class="card-body p-0"><div class="table-responsive"><table class="table table-hover mb-0"><thead class="table-light"><tr><th>รูป</th><th>ชื่อหมวดหมู่</th><th>รายละเอียด</th><th class="text-center">สินค้า</th><th class="text-center">จัดการ</th></tr></thead><tbody><% if(categories.length > 0){ %><% categories.forEach(category => { const modalId = "editCategoryModal" + category.name.replace(/[^a-zA-Z0-9]/g, ''); %><tr><td><img src="<%= category.imageUrl || 'https://via.placeholder.com/50/dee2e6/6c757d?text=N/A' %>" alt="Img" class="category-image-thumb" onerror="this.onerror=null; this.src='https://via.placeholder.com/50/dee2e6/6c757d?text=N/A';"></td><td><%= category.name %></td><td><small><%= category.description || '-' %></small></td><td class="text-center"><span class="badge bg-secondary rounded-pill"><%= category.productCount %></span></td><td class="text-center btn-action"><button class="btn btn-sm btn-warning me-1" data-bs-toggle="modal" data-bs-target="#<%= modalId %>" title="แก้ไข"><i class="bi bi-pencil-square"></i></button><form method="POST" action="/admin/categories/delete/<%= encodeURIComponent(category.name) %>" class="d-inline"><button type="submit" class="btn btn-sm btn-danger" <%= category.productCount > 0 ? 'disabled' : '' %> onclick="return confirm('ยืนยันลบหมวดหมู่: <%= category.name %> ? (ต้องไม่มีสินค้าในหมวดนี้)')" title="<%= category.productCount > 0 ? 'ไม่สามารถลบได้ มีสินค้าอยู่ ' + category.productCount + ' รายการ' : 'ลบหมวดหมู่' %>"><i class="bi bi-trash3"></i></button></form></td></tr><% }) %><% } else { %><tr><td colspan="5" class="text-center text-muted py-3">ยังไม่มีหมวดหมู่</td></tr><% } %></tbody></table></div></div></div></div><!-- Add Modal --><div class="modal fade" id="addCategoryModal" tabindex="-1" aria-hidden="true"><div class="modal-dialog"><div class="modal-content"><form method="POST" action="/admin/categories/add"><div class="modal-header"><h5 class="modal-title">เพิ่มหมวดหมู่ใหม่</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body"><div class="mb-3"><label class="form-label">ชื่อ*</label><input type="text" name="name" class="form-control" required></div><div class="mb-3"><label class="form-label">URL รูปภาพ</label><input type="url" name="imageUrl" class="form-control image-url-input" placeholder="https://..."><img src="" class="image-preview"><div class="form-text text-muted">https://... .jpg, .png, .gif, .webp</div></div><div class="mb-3"><label class="form-label">รายละเอียด</label><textarea name="description" class="form-control" rows="2"></textarea></div></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button><button type="submit" class="btn btn-primary">เพิ่ม</button></div></form></div></div></div><!-- Edit Modals --><% categories.forEach(category => { const modalId = "editCategoryModal" + category.name.replace(/[^a-zA-Z0-9]/g, ''); %><div class="modal fade" id="<%= modalId %>" tabindex="-1" aria-hidden="true"><div class="modal-dialog"><div class="modal-content"><form method="POST" action="/admin/categories/edit"><input type="hidden" name="originalName" value="<%= category.name %>"><div class="modal-header"><h5 class="modal-title">แก้ไข: <%= category.name %></h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body"><div class="mb-3"><label class="form-label">ชื่อใหม่*</label><input type="text" name="newName" class="form-control" value="<%= category.name %>" required></div><div class="mb-3"><label class="form-label">URL รูปภาพ</label><input type="url" name="imageUrl" class="form-control image-url-input" value="<%= category.imageUrl %>"><img src="<%= category.imageUrl %>" class="image-preview" style="<%= category.imageUrl ? 'display:block;' : '' %>" onerror="this.style.display='none';"><div class="form-text text-muted">https://... .jpg, .png, .gif, .webp</div></div><div class="mb-3"><label class="form-label">รายละเอียด</label><textarea name="description" class="form-control" rows="2"><%= category.description %></textarea></div><div class="alert alert-warning small p-2"><i class="bi bi-exclamation-triangle-fill"></i> การเปลี่ยนชื่อ จะอัปเดตสินค้าในหมวดนี้อัตโนมัติ</div></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button><button type="submit" class="btn btn-primary">บันทึก</button></div></form></div></div></div><% }) %><script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script><script>document.addEventListener('DOMContentLoaded',function(){const t=e=>{const o=e.querySelector('.image-url-input'),n=e.querySelector('.image-preview');if(!o||!n)return;const i=()=>{const t=o.value.trim(),l=/^(https?:\/\/).+\.(jpg|jpeg|png|gif|webp)([\?#].*)?$/i.test(t);l?(n.src=t,n.style.display='block',o.classList.remove('is-invalid'),n.onerror=()=>{n.style.display='none';o.classList.add('is-invalid')}) : (n.style.display='none',n.src='',t?o.classList.add('is-invalid'):o.classList.remove('is-invalid'))};o.addEventListener('input',i),o.dispatchEvent(new Event('input'))};document.querySelectorAll('.modal').forEach(t);const e=document.querySelector('.alert-success'),o=document.querySelector('.alert-danger');e&&setTimeout(()=>{try{new bootstrap.Alert(e).close()}catch(t){}},7e3),o&&setTimeout(()=>{try{new bootstrap.Alert(o).close()}catch(t){}},1e4)});</script></body></html>
`,
    'orders.ejs': `
<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>จัดการคำสั่งซื้อ - Admin</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"><style>th,td{vertical-align:middle;font-size:.9rem}.item-list{list-style:none;padding-left:0;margin-bottom:0}.item-list li{font-size:.85rem}.status-select{min-width:120px}.order-row{border-left:4px solid transparent;transition:border-color .3s ease,background-color .3s ease}.order-row:target{border-left-color:#0d6efd;background-color:#e7f1ff}body{padding-top:70px;background-color:#f8f9fa}.confirmation-link{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:middle}.btn-action form{display:inline}</style></head><body><%- include('navbar', { pageTitle: 'Orders' }) %><div class="container mt-4"><h2><i class="bi bi-receipt-cutoff"></i> จัดการคำสั่งซื้อ (<%= orders.length %> รายการ)</h2><!-- Display Messages/Errors --><% if (typeof message !== 'undefined' && message) { %><div class="alert alert-success alert-dismissible fade show" role="alert"><i class="bi bi-check-circle-fill"></i> <%= message %><button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div><% } %><% if (typeof error !== 'undefined' && error) { %><div class="alert alert-danger alert-dismissible fade show" role="alert"><i class="bi bi-exclamation-triangle-fill"></i> <%= error %><button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div><% } %><div class="card mt-3 shadow-sm"><div class="card-body p-0"><div class="table-responsive"><table class="table table-hover table-bordered mb-0"><thead class="table-light"><tr><th>#</th><th>รหัสสั่งซื้อ</th><th>ลูกค้า</th><th>รายการ (ชื่อ x จำนวน)</th><th>ยอดจ่าย (฿)</th><th>ส่วนลด</th><th>ช่องทาง</th><th>สถานะ</th><th>วันที่</th><th>ข้อมูลยืนยัน</th><th>จัดการ</th></tr></thead><tbody><% if(orders.length > 0){ %><% orders.forEach((order, index) => { const finalAmount = order.finalAmount !== undefined ? order.finalAmount : ((order.originalTotalAmount || 0) - (order.discountAmount || 0)); %><tr class="order-row" id="order-<%= order.id %>"><td><%= index + 1 %></td><td><small title="<%= order.id %>"><%= order.id.substring(0,16) %>...</small></td><td><small title="<%= order.userId %>"><%= order.userId.substring(0,6) %>...<%= order.userId.slice(-4) %></small></td><td><ul class="item-list"><% (order.items || []).forEach(item => { %><li><small title="ID: <%= item.productId %>"><b><%= item.name %></b> x <%= item.quantity %></small></li><% }) %></ul></td><td><b><%= finalAmount.toFixed(2) %></b></td><td><% if (order.discountAmount && order.discountAmount > 0) { %><span class="badge bg-danger" title="Code: <%= order.discountCode || 'N/A' %>">฿<%= order.discountAmount.toFixed(2) %></span><br><small class="text-muted"><%= order.discountCode %><% if (order.discountCode === 'AUTO_PROMO') { %> <i class="bi bi-stars text-warning" title="โปรโมชั่นอัตโนมัติ"></i><% } %></small><% } else { %><span class="text-muted">-</span><% } %></td><td><span class="badge bg-<%= order.paymentMethod==='angpao'?'danger':order.paymentMethod==='bank'?'info':order.paymentMethod==='redeem_code'?'primary':'secondary' %> text-capitalize"><i class="bi bi-<%= order.paymentMethod==='angpao'?'gift':order.paymentMethod==='bank'?'bank':order.paymentMethod==='redeem_code'?'key':'question-circle' %>"></i> <%= order.paymentMethod || 'N/A' %></span></td><td><form method="POST" action="/admin/orders/status/<%= order.id %>" class="d-inline-block"><select name="status" class="form-select form-select-sm status-select" onchange="this.form.submit()" title="เปลี่ยนสถานะ"><option value="pending" <%=order.status==='pending'?'selected':'' %>>⏳ รอดำเนินการ</option><option value="processing" <%=order.status==='processing'?'selected':'' %>>🔄 กำลังเตรียม</option><option value="completed" <%=order.status==='completed'?'selected':'' %>>✔️ สำเร็จ</option><option value="cancelled" <%=order.status==='cancelled'?'selected':'' %>>❌ ยกเลิก</option><option value="shipped" <%=order.status==='shipped'?'selected':'' %>>🚚 จัดส่งแล้ว</option><option value="refunded" <%=order.status==='refunded'?'selected':'' %>>💸 คืนเงิน</option></select></form></td><td><small title="Created: <%= new Date(order.createdAt || 0).toLocaleString('th-TH') %> | Updated: <%= new Date(order.updatedAt || 0).toLocaleString('th-TH') %>"><%= new Date(order.createdAt || 0).toLocaleString('th-TH', { dateStyle:'short', timeStyle:'short'}) %></small></td><td class="text-center"><% if(order.paymentConfirmation && (String(order.paymentConfirmation).startsWith('http'))){ %><a href="<%= order.paymentConfirmation %>" target="_blank" class="btn btn-sm btn-outline-secondary confirmation-link" title="ดู: <%= order.paymentConfirmation %>"><i class="bi bi-link-45deg"></i> ลิงก์/สลิป</a><% } else if(order.paymentConfirmation){ %><span class="badge bg-light text-dark" title="Ref/Code: <%= order.paymentConfirmation %>"><small><%= String(order.paymentConfirmation).substring(0,15) %>...</small></span><% } else { %> <span class="text-muted">-</span> <% } %></td><td class="text-center btn-action"><form method="POST" action="/admin/orders/delete/<%= order.id %>" class="d-inline"><button type="submit" class="btn btn-sm btn-outline-danger" onclick="return confirm('ยืนยันลบคำสั่งซื้อ: <%= order.id %> ?')" title="ลบคำสั่งซื้อนี้"><i class="bi bi-trash3"></i></button></form></td></tr><% }) %><% } else { %><tr><td colspan="11" class="text-center text-muted py-3">ยังไม่มีคำสั่งซื้อ</td></tr><% } %></tbody></table></div></div></div></div><script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script><script>document.addEventListener('DOMContentLoaded',function(){if(window.location.hash){const e=document.querySelector(window.location.hash);if(e){e.scrollIntoView({behavior:'smooth',block:'center'});e.style.transition='background-color 0.5s ease-in-out';e.style.backgroundColor='#e7f1ff';setTimeout(()=>{e.style.backgroundColor='transparent'},1500)}};const t=document.querySelector('.alert-success'),o=document.querySelector('.alert-danger');t&&setTimeout(()=>{try{new bootstrap.Alert(t).close()}catch(e){}},7e3),o&&setTimeout(()=>{try{new bootstrap.Alert(o).close()}catch(e){}},1e4)});</script></body></html>
`,
    'codes.ejs': `
<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>จัดการโค้ดรับของ - Admin</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"><style>body{padding-top:70px;background-color:#f8f9fa}.code-list{max-height:60vh;overflow-y:auto}.code-item{font-family:monospace;word-break:break-all}</style></head><body><%- include('navbar', { pageTitle: 'Redemption Codes' }) %><div class="container mt-4"><div class="d-flex justify-content-between align-items-center mb-3"><h2><i class="bi bi-key-fill"></i> จัดการโค้ดรับของ (<%= codes.length %> โค้ด)</h2><button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addCodeModal"><i class="bi bi-plus-circle"></i> เพิ่ม/สร้างโค้ด</button></div><!-- Display Messages/Errors --><% if (typeof message !== 'undefined' && message) { %><div class="alert alert-success alert-dismissible fade show" role="alert"><i class="bi bi-check-circle-fill"></i> <%= message %><button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div><% } %><% if (typeof error !== 'undefined' && error) { %><div class="alert alert-danger alert-dismissible fade show" role="alert"><i class="bi bi-exclamation-triangle-fill"></i> <%= error %><button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div><% } %><div class="card shadow-sm"><div class="card-header bg-light">รายการโค้ด (32 ตัวอักษร A-Z, 0-9)</div><div class="card-body"><% if(codes.length > 0){ %><div class="code-list border rounded p-3 mb-3"><ul class="list-group list-group-flush"><% codes.forEach(code => { %><li class="list-group-item d-flex justify-content-between align-items-center"><span class="code-item"><%= code %></span><form method="POST" action="/admin/codes/delete/<%= code %>" class="ms-2 d-inline"><button type="submit" class="btn btn-sm btn-outline-danger" onclick="return confirm('ยืนยันลบโค้ด: <%= code %> ?')" title="ลบโค้ดนี้"><i class="bi bi-trash3"></i></button></form></li><% }) %></ul></div><p class="text-muted small">โค้ดที่ใช้แล้วจะถูกลบอัตโนมัติเมื่อลูกค้าใช้งานสำเร็จ</p><% } else { %><p class="text-center text-muted py-3">ยังไม่มีโค้ดรับของในระบบ</p><% } %></div></div></div><!-- Add Code Modal --><div class="modal fade" id="addCodeModal" tabindex="-1" aria-hidden="true"><div class="modal-dialog"><div class="modal-content"><form method="POST" action="/admin/codes/add"><div class="modal-header"><h5 class="modal-title">เพิ่ม หรือ สร้างโค้ด</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body"><div class="mb-3"><label for="manualCode" class="form-label">เพิ่มโค้ดเอง (32 ตัว)</label><input type="text" name="code" id="manualCode" class="form-control text-uppercase" pattern="[A-Z0-9]{32}" title="ต้องเป็น A-Z หรือ 0-9 จำนวน 32 ตัว" placeholder="เว้นว่างเพื่อสร้างอัตโนมัติ"><div class="form-text">ต้องเป็น A-Z, 0-9 จำนวน 32 ตัวเท่านั้น.</div></div><hr><div class="mb-3"><label for="generateCount" class="form-label">สร้างอัตโนมัติ (จำนวน)</label><input type="number" name="count" id="generateCount" class="form-control" min="1" max="1000" value="10"><div class="form-text">ระบุจำนวน (1-1000) ระบบจะสร้างให้หากช่องบนเว้นว่าง</div></div></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button><button type="submit" class="btn btn-primary">เพิ่ม/สร้าง</button></div></form></div></div></div><script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script><script>document.addEventListener('DOMContentLoaded',function(){const t=document.querySelector('.alert-success'),e=document.querySelector('.alert-danger');t&&setTimeout(()=>{try{new bootstrap.Alert(t).close()}catch(t){}},7e3),e&&setTimeout(()=>{try{new bootstrap.Alert(e).close()}catch(t){}},1e4)});</script></body></html>
`,
    'settings.ejs': `
<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>ตั้งค่าระบบ - Admin</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"><style>body{padding-top:70px;background-color:#f8f9fa}textarea{font-family:monospace}.form-text{font-size:.875em}.form-check-input:checked{background-color:#198754;border-color:#198754}.alert i { vertical-align: -0.125em; } </style></head><body><%- include('navbar', { pageTitle: 'Settings' }) %><div class="container mt-4"><div class="d-flex justify-content-between align-items-center mb-3"><h2><i class="bi bi-gear-wide-connected"></i> ตั้งค่าระบบ</h2></div><!-- Display Messages/Errors --><% if (typeof message !== 'undefined' && message) { %><div class="alert alert-success alert-dismissible fade show" role="alert"><i class="bi bi-check-circle-fill"></i> <%= message %><button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div><% } %><% if (typeof error !== 'undefined' && error) { %><div class="alert alert-danger alert-dismissible fade show" role="alert"><i class="bi bi-exclamation-triangle-fill"></i> <%- error.replace(/\\\\n/g, '<br>') %><button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div><% } %><form method="POST" action="/admin/settings/save"><div class="card shadow-sm mb-4"><div class="card-header"><strong><i class="bi bi-facebook"></i> Facebook Messenger</strong></div><div class="card-body"><!-- Connection Status --><div id="connection-status" class="alert alert-<%= connectionStatus.status === 'success' ? 'success' : 'danger' %>" role="alert"><strong>สถานะเชื่อมต่อ Facebook:</strong> <%= connectionStatus.message %></div><div class="row"><div class="col-md-6 mb-3"><label for="fbVerifyToken" class="form-label">Verify Token*</label><input type="text" class="form-control" id="fbVerifyToken" name="fbVerifyToken" value="<%= config.fbVerifyToken %>" required><div class="form-text">ต้องตรงกับที่ตั้งใน Facebook App Webhook setup</div></div><div class="col-md-6 mb-3"><label for="adminContactLink" class="form-label">ลิงก์ติดต่อแอดมิน</label><input type="url" class="form-control" id="adminContactLink" name="adminContactLink" value="<%= config.adminContactLink %>" placeholder="https://m.me/YOUR_PAGE_ID"><div class="form-text">ลิงก์ m.me สำหรับปุ่มติดต่อแอดมิน (ถ้ามี)</div></div></div><div class="mb-3"><label for="fbPageAccessToken" class="form-label">Page Access Token</label><textarea class="form-control" id="fbPageAccessToken" name="fbPageAccessToken" rows="3"><%= config.fbPageAccessToken %></textarea><div class="form-text">Token ที่สร้างจาก Facebook App สำหรับเพจของคุณ (ควรใช้แบบอายุยาว)</div></div><div class="mb-3"><label for="welcomeGif" class="form-label">Welcome GIF URL</label><input type="url" class="form-control" id="welcomeGif" name="welcomeGif" value="<%= config.welcomeGif %>"><div class="form-text">URL รูป GIF ต้อนรับ (แนะนำ .gif ขนาดไม่ใหญ่มาก)</div></div></div></div><!-- Server Settings --><div class="card shadow-sm mb-4"><div class="card-header"><strong><i class="bi bi-hdd-network-fill"></i> Server & Connection</strong> <small>(**ต้องรีสตาร์ทเซิร์ฟเวอร์** หากแก้ไขส่วนนี้)</small></div><div class="card-body"><div class="row"><div class="col-md-4 mb-3"><label for="serverPort" class="form-label">Server Port*</label><input type="number" class="form-control" id="serverPort" name="serverPort" value="<%= config.serverPort %>" min="1" max="65535" required><div class="form-text">Port ที่เซิร์ฟเวอร์จะทำงาน (เช่น 3000 หรือ 8443)</div></div><div class="col-md-8 mb-3 align-self-center"><div class="form-check form-switch pt-3"><input class="form-check-input" type="checkbox" role="switch" id="enableHttps" name="enableHttps" <%= config.enableHttps ? 'checked' : '' %>><label class="form-check-label" for="enableHttps">เปิดใช้งาน HTTPS (แนะนำ)</label></div></div></div><div class="row"><div class="col-md-6 mb-3"><label for="sslKeyPath" class="form-label">SSL Private Key Path (.pem)</label><input type="text" class="form-control" id="sslKeyPath" name="sslKeyPath" value="<%= config.sslKeyPath %>" placeholder="/path/to/your/privkey.pem" <%= !config.enableHttps ? 'disabled' : '' %>><div class="form-text">ที่อยู่ไฟล์ Private Key (จำเป็นหากเปิด HTTPS)</div></div><div class="col-md-6 mb-3"><label for="sslCertPath" class="form-label">SSL Certificate Path (.pem)</label><input type="text" class="form-control" id="sslCertPath" name="sslCertPath" value="<%= config.sslCertPath %>" placeholder="/path/to/your/fullchain.pem" <%= !config.enableHttps ? 'disabled' : '' %>><div class="form-text">ที่อยู่ไฟล์ Certificate Chain (จำเป็นหากเปิด HTTPS)</div></div></div><div class="alert alert-warning small p-2"><i class="bi bi-exclamation-triangle-fill"></i> การเปลี่ยนแปลง Port หรือ HTTPS **ต้องรีสตาร์ทเซิร์ฟเวอร์** เพื่อให้มีผลสมบูรณ์</div></div></div><div class="card shadow-sm mb-4"><div class="card-header"><strong><i class="bi bi-megaphone-fill"></i> โปรโมชั่นอัตโนมัติ (ลดทั้งร้าน)</strong></div><div class="card-body"><div class="form-check form-switch mb-3"><input class="form-check-input" type="checkbox" role="switch" id="autoPromotionEnabled" name="autoPromotionEnabled" <%= config.autoPromotionEnabled ? 'checked' : '' %>><label class="form-check-label" for="autoPromotionEnabled">เปิดใช้งานโปรโมชั่นอัตโนมัติ</label></div><div class="row"><div class="col-md-6 mb-3"><label for="autoPromotionPercentage" class="form-label">เปอร์เซ็นต์ส่วนลด (%)</label><input type="number" class="form-control" id="autoPromotionPercentage" name="autoPromotionPercentage" value="<%= config.autoPromotionPercentage %>" min="0" max="100" step="0.1"><div class="form-text">ใส่ค่าระหว่าง 0-100 (เช่น 10 สำหรับ 10%)</div></div><div class="col-md-6 mb-3"><label for="autoPromotionMinPurchase" class="form-label">ยอดซื้อขั้นต่ำ (฿)</label><input type="number" class="form-control" id="autoPromotionMinPurchase" name="autoPromotionMinPurchase" value="<%= config.autoPromotionMinPurchase %>" min="0" step="0.01"><div class="form-text">ยอดซื้อขั้นต่ำในตะกร้าเพื่อรับส่วนลด (0 = ไม่มีขั้นต่ำ)</div></div></div><div class="alert alert-info small p-2"><i class="bi bi-info-circle"></i> หากเปิดใช้งาน ลูกค้าที่มียอดถึงขั้นต่ำจะได้รับส่วนลดนี้ทันที และจะไม่สามารถใช้โค้ดส่วนลดอื่นได้</div></div></div><div class="card shadow-sm mb-4"><div class="card-header"><strong><i class="bi bi-wallet2"></i> TrueMoney Wallet (Angpao)</strong></div><div class="card-body"><div class="row"><div class="col-md-6 mb-3"><label for="walletPhone" class="form-label">เบอร์ Wallet ร้านค้า (สำหรับรับซอง)*</label><input type="text" class="form-control" id="walletPhone" name="walletPhone" value="<%= config.walletPhone %>" pattern="[0-9]{10}" title="ใส่เบอร์โทรศัพท์ 10 หลัก" required><div class="form-text"><strong>สำคัญ:</strong> เบอร์ TrueMoney ที่บอทใช้กดรับเงินจากซองอั่งเปาที่ลูกค้าส่งมา</div></div><div class="col-md-6 mb-3"><label for="walletImage" class="form-label">Wallet Image URL</label><input type="url" class="form-control" id="walletImage" name="walletImage" value="<%= config.walletImage %>"><div class="form-text">URL รูปภาพสำหรับตัวเลือกจ่ายผ่าน Wallet</div></div></div></div></div><div class="card shadow-sm mb-4"><div class="card-header"><strong><i class="bi bi-bank"></i> Bank Transfer</strong></div><div class="card-body"><div class="mb-3"><label for="bankAccountDetails" class="form-label">ข้อมูลบัญชีธนาคาร*</label><textarea class="form-control" id="bankAccountDetails" name="bankAccountDetails" rows="4" required><%= config.bankAccountDetails %></textarea><div class="form-text">แสดงให้ลูกค้าเห็นตอนเลือกโอนเงิน (ใส่ ธนาคาร, เลขบัญชี, ชื่อบัญชี)</div></div><div class="mb-3"><label for="bankImage" class="form-label">Bank Logo Image URL</label><input type="url" class="form-control" id="bankImage" name="bankImage" value="<%= config.bankImage %>"><div class="form-text">URL รูปโลโก้ธนาคาร</div></div></div></div><div class="card shadow-sm mb-4"><div class="card-header"><strong><i class="bi bi-receipt"></i> Xncly Slip Check API</strong> <small>(สำหรับ Bank Transfer)</small></div><div class="card-body"><div class="mb-3"><label for="xnclyClientIdSecret" class="form-label">Xncly ClientID:Secret*</label><input type="text" class="form-control" id="xnclyClientIdSecret" name="xnclyClientIdSecret" value="<%= config.xnclyClientIdSecret %>" placeholder="ClientID:Secret" required><div class="form-text">รูปแบบ ClientID:Secret จาก <a href="https://xncly.xyz/" target="_blank">xncly.xyz</a></div></div><div class="mb-3"><label for="xnclyCheckUrl" class="form-label">Xncly Check URL*</label><input type="url" class="form-control" id="xnclyCheckUrl" name="xnclyCheckUrl" value="<%= config.xnclyCheckUrl %>" required></div></div></div><div class="card shadow-sm mb-4"><div class="card-header"><strong><i class="bi bi-key-fill"></i> Code Redemption & <i class="bi bi-percent"></i> Discounts Images</strong></div><div class="card-body"><div class="row"><div class="col-md-6 mb-3"><label for="codeRedemptionImage" class="form-label">Code Redemption Image URL</label><input type="url" class="form-control" id="codeRedemptionImage" name="codeRedemptionImage" value="<%= config.codeRedemptionImage %>"><div class="form-text">URL รูปภาพสำหรับตัวเลือกใช้โค้ดรับของ</div></div><div class="col-md-6 mb-3"><label for="discountImage" class="form-label">Discount Feature Image URL</label><input type="url" class="form-control" id="discountImage" name="discountImage" value="<%= config.discountImage %>"><div class="form-text">URL รูปภาพ (อาจใช้แสดงผลเกี่ยวกับส่วนลด)</div></div></div></div></div><div class="text-center mb-4"><button type="submit" class="btn btn-primary btn-lg"><i class="bi bi-save-fill"></i> บันทึกการตั้งค่าทั้งหมด</button></div></form></div><script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script><script>document.addEventListener('DOMContentLoaded', function() { const httpsSwitch = document.getElementById('enableHttps'); const keyPathInput = document.getElementById('sslKeyPath'); const certPathInput = document.getElementById('sslCertPath'); function toggleSslInputs() { const isEnabled = httpsSwitch.checked; keyPathInput.disabled = !isEnabled; certPathInput.disabled = !isEnabled; keyPathInput.required = isEnabled; certPathInput.required = isEnabled; } httpsSwitch.addEventListener('change', toggleSslInputs); toggleSslInputs(); const successAlert = document.querySelector('.alert-success'); const errorAlert = document.querySelector('.alert-danger'); if (successAlert) { setTimeout(() => { try { new bootstrap.Alert(successAlert).close(); } catch (e) {} }, 7000); } if (errorAlert) { setTimeout(() => { try { new bootstrap.Alert(errorAlert).close(); } catch (e) {} }, 15000); } });</script></body></html>
`,
    'discounts.ejs': `
<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>จัดการโค้ดส่วนลด - Admin</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"><style>th,td{vertical-align:middle;font-size:.9rem}body{padding-top:70px;background-color:#f8f9fa}.btn-action form{display:inline}.form-text{font-size:.875em}.code-input{text-transform:uppercase;font-family:monospace}.expired{color:#6c757d; text-decoration: line-through;}.used-up{color:#6c757d; font-style: italic;}</style></head><body><%- include('navbar', { pageTitle: 'Discount Codes' }) %><div class="container mt-4"><div class="d-flex justify-content-between align-items-center mb-3"><h2><i class="bi bi-percent"></i> จัดการโค้ดส่วนลด (<%= discounts.length %> รายการ)</h2><button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addDiscountModal"><i class="bi bi-plus-circle"></i> เพิ่มโค้ดส่วนลด</button></div><!-- Display Messages/Errors --><% if (typeof message !== 'undefined' && message) { %><div class="alert alert-success alert-dismissible fade show" role="alert"><i class="bi bi-check-circle-fill"></i> <%= message %><button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div><% } %><% if (typeof error !== 'undefined' && error) { %><div class="alert alert-danger alert-dismissible fade show" role="alert"><i class="bi bi-exclamation-triangle-fill"></i> <%- error.replace(/\\\\n/g, '<br>') %><button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div><% } %><div class="card shadow-sm"><div class="card-body p-0"><div class="table-responsive"><table class="table table-striped table-hover mb-0"><thead class="table-light"><tr><th>โค้ด</th><th>ประเภท</th><th>มูลค่า</th><th>ใช้ไป/จำกัด</th><th>ซื้อขั้นต่ำ(฿)</th><th>วันหมดอายุ</th><th>จัดการ</th></tr></thead><tbody><% if(discounts.length > 0){ %><% discounts.forEach(discount => { const isExpired = discount.expiresAt && new Date(discount.expiresAt) < new Date(); const isUsedUp = discount.maxUses !== null && (discount.uses || 0) >= discount.maxUses; const isInactive = isExpired || isUsedUp; const modalId = "editDiscountModal" + discount.id.replace(/[^a-zA-Z0-9]/g, ''); %><tr><td class="<%= isInactive ? 'text-muted' : '' %> <%= isExpired ? 'expired' : (isUsedUp ? 'used-up' : '') %>"><%= discount.code %><% if (isExpired){ %><span class="badge bg-secondary ms-1">หมดอายุ</span><% } else if (isUsedUp){ %><span class="badge bg-secondary ms-1">ใช้ครบ</span><% } %></td><td class="text-capitalize"><%= discount.type %></td><td><%= discount.type === 'percentage' ? discount.value + '%' : '฿' + discount.value.toFixed(2) %></td><td><%= discount.uses || 0 %> / <%= discount.maxUses === null ? '∞' : discount.maxUses %></td><td><%= discount.minPurchase > 0 ? discount.minPurchase.toFixed(2) : '-' %></td><td><%= discount.expiresAt ? new Date(discount.expiresAt).toLocaleDateString('th-TH', { year:'numeric', month:'short', day:'numeric'}) : '-' %></td><td class="text-center btn-action"><button class="btn btn-sm btn-warning me-1" data-bs-toggle="modal" data-bs-target="#<%= modalId %>" title="แก้ไข"><i class="bi bi-pencil-square"></i></button><form method="POST" action="/admin/discounts/delete/<%= discount.id %>" class="d-inline"><button type="submit" class="btn btn-sm btn-danger" onclick="return confirm('ยืนยันลบโค้ดส่วนลด: <%= discount.code %> ?')" title="ลบ"><i class="bi bi-trash3"></i></button></form></td></tr><% }) %><% } else { %><tr><td colspan="7" class="text-center text-muted py-3">ยังไม่มีโค้ดส่วนลดในระบบ</td></tr><% } %></tbody></table></div></div></div></div><!-- Add Discount Modal --><div class="modal fade" id="addDiscountModal" tabindex="-1" aria-hidden="true"><div class="modal-dialog modal-lg"><div class="modal-content"><form method="POST" action="/admin/discounts/add"><div class="modal-header"><h5 class="modal-title">เพิ่มโค้ดส่วนลดใหม่</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body"><div class="mb-3"><label for="addCode" class="form-label">โค้ดส่วนลด*</label><input type="text" name="code" id="addCode" class="form-control code-input" required pattern="[A-Z0-9]{3,20}" title="3-20 ตัวอักษร A-Z หรือ 0-9 เท่านั้น"><div class="form-text">ตัวพิมพ์เล็กจะถูกแปลงเป็นพิมพ์ใหญ่ (3-20 ตัวอักษร)</div></div><div class="row"><div class="col-md-6 mb-3"><label for="addType" class="form-label">ประเภทส่วนลด*</label><select name="type" id="addType" class="form-select" required><option value="percentage" selected>เปอร์เซ็นต์ (%)</option><option value="fixed">จำนวนเงินคงที่ (฿)</option></select></div><div class="col-md-6 mb-3"><label for="addValue" class="form-label">มูลค่าส่วนลด*</label><input type="number" name="value" id="addValue" class="form-control" required step="any" min="0.01"><div class="form-text">เช่น 10 สำหรับ 10% หรือ 50 สำหรับ ฿50 (ต้องมากกว่า 0)</div></div></div><div class="row"><div class="col-md-4 mb-3"><label for="addMaxUses" class="form-label">จำนวนครั้งที่ใช้ได้สูงสุด</label><input type="number" name="maxUses" id="addMaxUses" class="form-control" min="1" placeholder="เว้นว่าง=ไม่จำกัด"></div><div class="col-md-4 mb-3"><label for="addMinPurchase" class="form-label">ยอดซื้อขั้นต่ำ (฿)</label><input type="number" name="minPurchase" id="addMinPurchase" class="form-control" step="0.01" min="0" value="0" placeholder="0 หรือเว้นว่าง=ไม่มีขั้นต่ำ"></div><div class="col-md-4 mb-3"><label for="addExpiresAt" class="form-label">วันหมดอายุ</label><input type="date" name="expiresAt" id="addExpiresAt" class="form-control"><div class="form-text">เว้นว่าง=ไม่มีหมดอายุ</div></div></div></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button><button type="submit" class="btn btn-primary">เพิ่มโค้ด</button></div></form></div></div></div><!-- Edit Discount Modals --><% discounts.forEach(discount => { const expiresValue = discount.expiresAt ? new Date(discount.expiresAt).toISOString().split('T')[0] : ''; const modalId = "editDiscountModal" + discount.id.replace(/[^a-zA-Z0-9]/g, ''); %><div class="modal fade" id="<%= modalId %>" tabindex="-1" aria-hidden="true"><div class="modal-dialog modal-lg"><div class="modal-content"><form method="POST" action="/admin/discounts/edit/<%= discount.id %>"><div class="modal-header"><h5 class="modal-title">แก้ไขโค้ด: <%= discount.code %></h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body"><div class="mb-3"><label class="form-label">โค้ดส่วนลด*</label><input type="text" name="code" class="form-control code-input" value="<%= discount.code %>" required pattern="[A-Z0-9]{3,20}" title="3-20 ตัวอักษร A-Z หรือ 0-9 เท่านั้น"></div><div class="row"><div class="col-md-6 mb-3"><label class="form-label">ประเภทส่วนลด*</label><select name="type" class="form-select" required><option value="percentage" <%= discount.type === 'percentage' ? 'selected' : '' %>>เปอร์เซ็นต์ (%)</option><option value="fixed" <%= discount.type === 'fixed' ? 'selected' : '' %>>จำนวนเงินคงที่ (฿)</option></select></div><div class="col-md-6 mb-3"><label class="form-label">มูลค่าส่วนลด*</label><input type="number" name="value" class="form-control" value="<%= discount.value %>" required step="any" min="0.01"></div></div><div class="row"><div class="col-md-4 mb-3"><label class="form-label">จำนวนครั้งที่ใช้ได้สูงสุด</label><input type="number" name="maxUses" class="form-control" value="<%= discount.maxUses || '' %>" min="1" placeholder="เว้นว่าง=ไม่จำกัด"><div class="form-text">ใช้ไปแล้ว: <%= discount.uses || 0 %> ครั้ง</div></div><div class="col-md-4 mb-3"><label class="form-label">ยอดซื้อขั้นต่ำ (฿)</label><input type="number" name="minPurchase" class="form-control" value="<%= discount.minPurchase || '0' %>" step="0.01" min="0" placeholder="0=ไม่มีขั้นต่ำ"></div><div class="col-md-4 mb-3"><label class="form-label">วันหมดอายุ</label><input type="date" name="expiresAt" class="form-control" value="<%= expiresValue %>"><div class="form-text">เว้นว่าง=ไม่มีหมดอายุ</div></div></div><p class="small text-muted">ID: <%= discount.id %><br>Created: <%= new Date(discount.createdAt).toLocaleString('th-TH') %></p></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button><button type="submit" class="btn btn-primary">บันทึกการเปลี่ยนแปลง</button></div></form></div></div></div><% }) %><script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script><script>document.addEventListener('DOMContentLoaded',function(){const t=document.querySelector('.alert-success'),e=document.querySelector('.alert-danger');t&&setTimeout(()=>{try{new bootstrap.Alert(t).close()}catch(t){}},7e3),e&&setTimeout(()=>{try{new bootstrap.Alert(e).close()}catch(t){}},15e3)});</script></body></html>
`
};

Object.entries(templates).forEach(([filename, content]) => {
    const filepath = path.join(viewsDir, filename);
    try {
        fs.mkdirSync(path.dirname(filepath), { recursive: true });
        // Only write if content differs, prevents unnecessary file timestamp changes
        let existingContent = '';
        if (fs.existsSync(filepath)) {
            existingContent = fs.readFileSync(filepath, 'utf8');
        }
        const newContent = content.trim();
        if (existingContent !== newContent) {
            fs.writeFileSync(filepath, newContent, 'utf8');
            console.log(`Admin template '${filename}' created/updated.`);
        }
    } catch (error) {
        console.error(`Error writing template ${filename}:`, error);
    }
});
// --- End EJS Setup ---

// --- Server Startup Logic ---
function startServer() {
    const PORT = loadedConfig.serverPort;
    let useHttps = loadedConfig.enableHttps;
    let credentials = null;

    if (useHttps) {
        try {
            if (!loadedConfig.sslKeyPath || !loadedConfig.sslCertPath) {
                throw new Error("SSL Key Path or Cert Path is missing in config.");
            }
            fs.accessSync(loadedConfig.sslKeyPath, fs.constants.R_OK);
            fs.accessSync(loadedConfig.sslCertPath, fs.constants.R_OK);
            const privateKey = fs.readFileSync(loadedConfig.sslKeyPath, 'utf8');
            const certificate = fs.readFileSync(loadedConfig.sslCertPath, 'utf8');
            credentials = { key: privateKey, cert: certificate };
            console.log("SSL certificates loaded successfully from configured paths.");
        } catch (error) {
            console.warn(`---------------------------------------------------`);
            console.warn("⚠️ WARNING: Could not load SSL certificates.");
            console.warn(`   Error: ${error.message}`);
            console.warn(`   Key Path Attempted: ${loadedConfig.sslKeyPath}`);
            console.warn(`   Cert Path Attempted: ${loadedConfig.sslCertPath}`);
            console.warn("   Falling back to HTTP server.");
            console.warn("   Verify paths and file permissions in /admin/settings and RESTART.");
            console.warn(`---------------------------------------------------`);
            useHttps = false;
        }
    }

    if (useHttps && credentials) {
        serverInstance = https.createServer(credentials, app);
        serverInstance.listen(PORT, () => {
            const domainMatch = String(loadedConfig.sslCertPath).match(/live\/([^\/]+)\//);
            const domain = domainMatch ? domainMatch[1] : 'YOUR_DOMAIN.COM';
            console.log(`---------------------------------------------------`);
            console.log(`✅ HTTPS Server running on port ${PORT}`);
            console.log(`🔗 Admin Dashboard: https://${domain}:${PORT}/admin`);
            console.log(`🔗 Webhook URL:     https://${domain}:${PORT}/webhook`);
            console.log(`   (Verify Token in FB App: ${loadedConfig.fbVerifyToken})`);
            console.log(`---------------------------------------------------`);
        });
    } else {
        serverInstance = http.createServer(app);
        serverInstance.listen(PORT, () => {
            console.warn(`---------------------------------------------------`);
            console.warn(`⚠️ Running HTTP server on port ${PORT}. HTTPS is highly recommended!`);
            console.warn(`🔗 Admin Dashboard (HTTP): http://localhost:${PORT}/admin (or your server's IP)`);
            console.warn(`🔗 Webhook URL (HTTP): Requires tunneling (e.g., ngrok) for Facebook.`);
            console.warn(`   Example (ngrok): https://<your-ngrok-id>.ngrok-free.app/webhook`); // Updated ngrok domain
            console.warn(`   (Verify Token in FB App: ${loadedConfig.fbVerifyToken})`);
            console.warn(`   Configure HTTPS in /admin/settings for production & restart.`);
            console.warn(`---------------------------------------------------`);
        });
    }

    serverInstance.on('error', (error) => {
        if (error.syscall !== 'listen') {
            throw error;
        }
        const bind = typeof PORT === 'string' ? 'Pipe ' + PORT : 'Port ' + PORT;
        switch (error.code) {
            case 'EACCES':
                console.error(`❌ FATAL ERROR: ${bind} requires elevated privileges.`);
                process.exit(1);
                break;
            case 'EADDRINUSE':
                console.error(`❌ FATAL ERROR: ${bind} is already in use. Is another instance running?`);
                process.exit(1);
                break;
            default:
                console.error("❌ FATAL SERVER ERROR:", error);
                process.exit(1);
        }
    });

    console.log(`ℹ️ Auto Promotion Status: ${loadedConfig.autoPromotionEnabled ? `ENABLED (${loadedConfig.autoPromotionPercentage}% over ${loadedConfig.autoPromotionMinPurchase} THB)` : 'DISABLED'}`);
    if (loadedConfig.fbVerifyToken === DEFAULT_CONFIG.fbVerifyToken || !loadedConfig.fbPageAccessToken || !loadedConfig.walletPhone || !loadedConfig.xnclyClientIdSecret || !loadedConfig.xnclyClientIdSecret.includes(':')) {
            console.warn("⚠️ WARNING: Essential FB/Payment settings missing or incomplete. Please configure via /admin/settings!");
    }
    console.log(`---------------------------------------------------`);
}

// --- Initial File Creation Checks ---
function createInitialFiles() {
    if (!fs.existsSync(CONFIG_FILE)) {
         console.log("Initial config.json will be created with default/detected values by loadConfig().");
    }

    const filesToCreate = {
        'package.json': () => JSON.stringify({
            "name": "fb-messenger-shop-v5-1-1", // Updated name
            "version": "5.1.1", // Version match
            "description": "Facebook Messenger Bot shop with Angpao (Redeem), Xncly Slip (transRef), Code Redemption, Quantity Stock, Manual & Auto Discounts, and full Web Config including Server/SSL.",
            "main": "index.js",
            "scripts": { "start": "node index.js" },
            "dependencies": {
                "axios": "^1.6.8", // Pinned or latest compatible
                "body-parser": "^1.20.2",
                "ejs": "^3.1.9",
                "express": "^4.18.3", // Updated Express
                "form-data": "^4.0.0",
                "request": "^2.88.2" // Still used
            },
            "engines": { "node": ">=16.0.0" } // Minimum Node version
        }, null, 2),
        'README.md': () => `# FB Messenger Shop Bot (v5.1.1 - Angpao Redeem, Slip transRef)\n\nFeatures:\n*   TrueMoney Angpao (**Auto Redeem via API** - requires shop wallet number in config)\n*   Bank Transfer (Xncly Slip Verification + **transRef Duplicate Check**)\n*   Code Redemption (32-char codes)\n*   Manual Discount Codes: Manage %/fixed discounts with limits, expiry, min purchase.\n*   Automatic Promotion: Configure store-wide % discount with min purchase.\n*   Quantity-Based Stock: Unique data per item consumed on purchase.\n*   **Full Web-Based Configuration (/admin/settings):**\n    *   Manage Tokens (FB Verify, Page Access), API Keys (Xncly).\n    *   Wallet/Bank Info.\n    *   Auto Promotion Settings.\n    *   **Server Port & HTTPS/SSL Configuration (Key/Cert Paths).**\n    *   Facebook Connection Status Check.\n*   Admin Dashboard: Manage products, categories, orders, redemption codes, manual discount codes, settings.\n\n## Setup\n\n1.  **Install:** ` + "`npm install`" + `\n2.  **Configure:**\n    *   Run the bot once (` + "`npm start`" + `) to generate initial \`config.json\` and other data files. It will try to detect default SSL certs to guess HTTPS.\n    *   Access the Admin Panel (URL shown in console, e.g., \`http://localhost:3000/admin\` or \`https://YOUR_DOMAIN:8443/admin\`).\n    *   Go to **Settings** (\`/admin/settings\`) and fill in ALL required fields. Pay special attention to:\n        *   Facebook Tokens (Verify & Page Access).\n        *   Payment Details:\n            *   **Wallet Phone:** *Required* for the bot to automatically redeem Angpao links.\n            *   Bank Info.\n            *   Xncly Key.\n        *   **Server & Connection:** Set the desired Port. Enable HTTPS and provide **correct, full paths** to your SSL certificate (\`fullchain.pem\`) and private key (\`privkey.pem\`) files for production.\n    *   Configure Auto Promotion and add Manual Discount Codes (\`/admin/discounts\`) if needed.\n    *   **VERY IMPORTANT:** You **MUST RESTART** the bot (` + "`Ctrl+C`" + ` then ` + "`npm start`" + `) after saving any changes in the "Server & Connection" section (Port, HTTPS toggle, SSL Paths).\n    *   Other settings changes (like FB tokens, payment info) usually take effect immediately or after a short delay (check FB Connection Status).\n3.  **Facebook App:**\n    *   Setup Messenger Platform integration.\n    *   Add Webhook: URL from server startup logs (use HTTPS URL if enabled!), Verify Token from \`/admin/settings\`.\n    *   Subscribe to \`messages\`, \`messaging_postbacks\`.\n    *   Ensure Page Access Token matches.\n4.  **Add Content:** Use the admin panel to add categories, products (with stock items), and redemption codes.\n5.  **Run:** ` + "`npm start`" + `\n\n## Security\n\n**The admin panel (\`/admin\`) has NO built-in password protection.** Secure it yourself (e.g., using basic auth, IP filtering, Cloudflare Access, reverse proxy with auth). Do NOT expose it directly to the internet without protection.`,
        '.gitignore': () => `node_modules\n*.log\n*.log.*\n\n# Sensitive Configuration & Data\nconfig.json\nshop_data.json\nverified_slips.json\nredemption_codes.json\ndiscount_codes.json\n\n# SSL Certificates\n*.pem\n\n# Environment Files\n*.env\n\n# OS generated files\n.DS_Store\nThumbs.db\n\n# NPM/Yarn generated logs\nnpm-debug.log*\nyarn-debug.log*\nyarn-error.log*`
    };

    Object.entries(filesToCreate).forEach(([filename, contentFn]) => {
        const filepath = path.join(__dirname, filename);
        if (!fs.existsSync(filepath)) {
            try {
                fs.writeFileSync(filepath, contentFn().trim() + '\n', 'utf8');
                console.log(`Created initial file: ${filename}`);
                if (filename === 'package.json') console.log("--> Run 'npm install' if you haven't already! <--");
            } catch (error) {
                console.error(`Error creating initial file ${filename}:`, error);
            }
        } else if (filename === '.gitignore' || filename === 'package.json') {
             try {
                 const currentContent = fs.readFileSync(filepath, 'utf8');
                 const newContentStr = contentFn().trim() + '\n';

                 if (filename === 'package.json' && currentContent !== newContentStr) {
                     fs.writeFileSync(filepath, newContentStr, 'utf8');
                      console.log(`Updated ${filename}. Run 'npm install'.`);
                 } else if (filename === '.gitignore') {
                      let toAppend = '';
                      const filesToIgnore = [
                          'config.json', 'shop_data.json', 'verified_slips.json',
                          'redemption_codes.json', 'discount_codes.json', '*.pem', '.env'
                      ];
                      const lines = currentContent.split('\n').map(l => l.trim());
                      filesToIgnore.forEach(f => {
                          if (!lines.includes(f)) {
                              toAppend += `\n${f}`;
                          }
                      });
                      if (toAppend) {
                          fs.appendFileSync(filepath, toAppend + '\n');
                          console.log(`Updated .gitignore to include: ${toAppend.trim().replace(/\n/g, ', ')}`);
                      }
                 }
             } catch(error) {
                  console.error(`Error checking/updating ${filename}:`, error);
             }
        }
    });

    // Ensure essential data files exist after load attempts
    if (!fs.existsSync(DATA_FILE)) saveShopData(); // Creates shop_data.json
    if (!fs.existsSync(VERIFIED_SLIPS_FILE)) saveVerifiedSlips(); // Creates verified_slips.json
    if (!fs.existsSync(REDEMPTION_CODES_FILE)) saveValidRedemptionCodes(); // Creates redemption_codes.json
    if (!fs.existsSync(DISCOUNT_CODES_FILE)) saveDiscountCodes(); // Creates discount_codes.json
}

// --- Start Application ---
createInitialFiles(); // Ensure supporting files like package.json, readme, gitignore exist
startServer(); // Start the HTTP/HTTPS server
