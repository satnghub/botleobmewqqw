
const express = require('express');
const bodyParser = require('body-parser');
const request = require('request'); // Still used for simpler Facebook API calls
const fs = require('fs');
const path = require('path');
const FormData = require('form-data'); // Needed for slip upload
const https = require('https');
const { Writable } = require('stream'); // Needed for downloading image to buffer
const axios = require('axios'); // For Xncly Slip Check API
const crypto = require('crypto'); // For code generation/hashing

// --- File Paths ---
const DATA_DIR = __dirname; // Store data in the same directory as the script
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DATA_FILE = path.join(DATA_DIR, 'shop_data.json');
const VERIFIED_SLIPS_FILE = path.join(DATA_DIR, 'verified_slips.json');
const REDEMPTION_CODES_FILE = path.join(DATA_DIR, 'redemption_codes.json');

// --- Default Configuration (used if config.json is missing/invalid) ---
const DEFAULT_CONFIG = {
    walletPhone: '',
    walletImage: 'https://res09.bignox.com/appcenter/th/2020/05/TrueMoney.jpg',
    welcomeGif: 'https://i.pinimg.com/originals/fe/f4/1f/fef41f9945b81122f30e216d02efd0a7.gif',
    bankAccountDetails: "ธนาคาร: กรอกใน Admin\nเลขบัญชี: กรอกใน Admin\nชื่อบัญชี: กรอกใน Admin",
    bankImage: 'https://i.pinimg.com/474x/c8/7a/a5/c87aa5a2adc0ac60659100f3e880aa41.jpg',
    codeRedemptionImage: 'https://cdn-icons-png.flaticon.com/512/1087/1087815.png',
    xnclyClientIdSecret: '', // Format: CLIENTID:SECRET
    xnclyCheckUrl: 'https://ccd.xncly.xyz/api/check-slip',
    fbVerifyToken: 'replace_this_in_admin_settings', // Replace with a random strong string
    fbPageAccessToken: '',
    adminContactLink: 'https://m.me/YOUR_PAGE_ID_HERE' // Replace with your page's message link
};

// --- Global Variables ---
let loadedConfig = { ...DEFAULT_CONFIG }; // Start with defaults
let shopData = {};
let verifiedSlips = [];
let validRedemptionCodes = [];

// --- Configuration Loading/Saving ---
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const fileContent = fs.readFileSync(CONFIG_FILE, 'utf8');
            const parsedConfig = JSON.parse(fileContent);
            // Merge loaded config with defaults to ensure all keys exist
            loadedConfig = { ...DEFAULT_CONFIG, ...parsedConfig };
            console.log("Configuration loaded successfully from config.json.");
        } else {
            console.warn("config.json not found. Using default values. Please configure settings via /admin/settings.");
            saveConfig(); // Create the file with default values
        }
    } catch (error) {
        console.error(`Error loading config.json: ${error.message}. Using default values.`);
        loadedConfig = { ...DEFAULT_CONFIG }; // Reset to defaults on error
    }
}

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(loadedConfig, null, 2), 'utf8');
        console.log("Configuration saved to config.json.");
    } catch (error) {
        console.error("Error saving configuration to config.json:", error);
    }
}

// --- SSL Configuration ---
// Paths should ideally be configurable too, but keeping simple for now
const privateKeyPath = '/etc/letsencrypt/live/scriptbotonline.vipv2boxth.xyz/privkey.pem'; // Adjust domain if needed
const certificatePath = '/etc/letsencrypt/live/scriptbotonline.vipv2boxth.xyz/fullchain.pem'; // Adjust domain if needed

let credentials = {};
let useHttps = false;

try {
    const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
    const certificate = fs.readFileSync(certificatePath, 'utf8');
    credentials = { key: privateKey, cert: certificate };
    useHttps = true;
    console.log("SSL certificates loaded successfully. Running HTTPS server.");
} catch (error) {
    console.warn("Warning: Could not load SSL certificates. Running HTTP server instead.", error.message);
    console.warn(`Make sure '${privateKeyPath}' and '${certificatePath}' exist or configure paths.`);
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
        // *** NEW: Ensure products have stockItems array ***
        shopData.products = shopData.products.map(p => ({
            ...p,
            stockItems: Array.isArray(p.stockItems) ? p.stockItems : [], // Ensure stockItems is an array
            // Derive stock count from stockItems length (remove old 'stock' if it exists)
            stock: Array.isArray(p.stockItems) ? p.stockItems.length : 0
        }));
        if (typeof shopData.users !== 'object' || shopData.users === null) shopData.users = {};
        if (!Array.isArray(shopData.orders)) shopData.orders = [];
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
        console.log(`Loaded ${verifiedSlips.length} verified slip references.`);
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

// --- Save Data Functions ---
function saveShopData() {
    try {
        // Before saving, ensure derived 'stock' count is up-to-date
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

// --- Express App Setup ---
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- Facebook Messenger API Functions (Modified to use loadedConfig) ---
async function sendApiRequest(options) {
    // Add Access Token from loaded config if not already present
    if (!options.qs || !options.qs.access_token) {
        options.qs = { ...options.qs, access_token: loadedConfig.fbPageAccessToken };
    }

    // Basic check if token is configured
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
                 // Handle specific user block errors without crashing
                if (body.error.code === 100 && (body.error.error_subcode === 2018278 || body.error.error_subcode === 2018001 || body.error.error_subcode === 2018108)) {
                     console.log(`User ${options.json?.recipient?.id || '?'} may have blocked the page or messaging is restricted. Error: ${body.error.message}`);
                     resolve({ error: 'USER_BLOCKED_OR_RESTRICTED', details: body.error }); // Resolve with error info
                } else {
                    console.error(`API Request Facebook Error (${options.url}):`, JSON.stringify(body.error));
                    // Specific check for token issues
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
        await sendApiRequest(options); // Token added by sendApiRequest
    } catch (error) {
        // Ignore errors for typing indicators
    }
}

async function sendMessage(sender, text) {
    if (!sender || !text) return;
    try {
        await sendTypingIndicator(sender, 'typing_on');
        const options = {
            url: 'https://graph.facebook.com/v19.0/me/messages',
            method: 'POST',
            json: {
                recipient: { id: sender },
                message: { text: text },
            }
        };
        await sendApiRequest(options); // Token added by sendApiRequest
    } catch (error) {
        console.error(`Error sending text message to ${sender}:`, error.message || error);
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
                message: {
                    attachment: {
                        type: "image",
                        payload: { url: imageUrl, is_reusable: true }
                    }
                }
            }
        };
        await sendApiRequest(options); // Token added by sendApiRequest
    } catch (error) {
         console.error(`Error sending image message to ${sender}:`, error.message || error);
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
                message: {
                    attachment: {
                        type: "template",
                        payload: {
                            template_type: "generic",
                            elements: elements.slice(0, 10)
                        }
                    }
                }
            }
        };
        await sendApiRequest(options); // Token added by sendApiRequest
    } catch (error) {
        console.error(`Error sending generic template to ${sender}:`, error.message || error);
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
                message: {
                    attachment: {
                        type: "template",
                        payload: {
                            template_type: "button",
                            text: text,
                            buttons: buttons.slice(0, 3)
                        }
                    }
                }
            }
        };
        await sendApiRequest(options); // Token added by sendApiRequest
    } catch (error) {
        console.error(`Error sending button template to ${sender}:`, error.message || error);
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
                message: {
                    text: text,
                    quick_replies: quickReplies.slice(0, 13)
                }
            }
        };
        await sendApiRequest(options); // Token added by sendApiRequest
    } catch (error) {
        console.error(`Error sending quick replies to ${sender}:`, error.message || error);
    } finally {
        await sendTypingIndicator(sender, 'typing_off');
    }
}
// --- End Facebook API Functions ---

// --- Shop Logic Functions (Modified for stockItems) ---
function getUserData(sender) {
    if (!shopData.users[sender]) {
        shopData.users[sender] = { cart: [], lastCategory: null, lastViewedProducts: [], currentPage: 0, checkoutState: null };
        saveShopData();
    }
    if (!shopData.users[sender].checkoutState) {
        shopData.users[sender].checkoutState = null;
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
            image_url: category.imageUrl || "https://via.placeholder.com/300x200?text=Category",
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
        const pageSize = 5;
        const skip = page * pageSize;
        const productsInCategory = shopData.products.filter(p => p.category === categoryName);
        const productsToShow = productsInCategory
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            .slice(skip, skip + pageSize);
        const totalProducts = productsInCategory.length;

        // Update derived stock count just in case
        productsToShow.forEach(p => p.stock = p.stockItems.length);

        if (productsToShow.length === 0) {
            await sendMessage(sender, page === 0 ? `ขออภัย ไม่พบสินค้าในหมวดหมู่ "${categoryName}"` : "ไม่มีสินค้าเพิ่มเติมในหมวดหมู่นี้แล้ว");
            await sendButtonTemplate(sender, "กลับไปเลือกหมวดหมู่อื่นๆ", [{ type: "postback", title: "เลือกหมวดหมู่", payload: "SHOW_CATEGORIES" }]);
            return;
        }

        const user = getUserData(sender);
        user.lastCategory = categoryName;
        user.lastViewedProducts = productsToShow.map(p => p.id);
        user.currentPage = page;
        saveShopData(); // Save user state update

        await sendMessage(sender, `🔎 สินค้าในหมวดหมู่ "${categoryName}" (หน้า ${page + 1}):`);

        const elements = productsToShow.map(product => ({
            title: product.name + (product.stock <= 0 ? ' (หมด)' : ''),
            subtitle: `฿${product.price} | ${product.language || 'N/A'} | เหลือ ${product.stock} ชิ้น`, // Use derived stock
            image_url: product.imageUrl || "https://via.placeholder.com/300x200?text=Product",
            buttons: [
                { type: "postback", title: "ดูรายละเอียด", payload: `PRODUCT_VIEW_${product.id}` },
                ...(product.stock > 0 ? [{ type: "postback", title: "➕ หยิบใส่ตะกร้า", payload: `PRODUCT_ADD_TO_CART_${product.id}` }] : [])
            ]
        }));
        await sendGenericTemplate(sender, elements);

        const buttons = [];
        if (totalProducts > (page + 1) * pageSize) {
            buttons.push({ type: "postback", title: "➡️ หน้าถัดไป", payload: `MORE_PRODUCTS_${categoryName}_${page + 1}` });
        }
        buttons.push({ type: "postback", title: "กลับไปหมวดหมู่", payload: "SHOW_CATEGORIES" });
        buttons.push({ type: "postback", title: "🛒 ดูตะกร้า", payload: "CART_VIEW" });
        await sendButtonTemplate(sender, `แสดง ${skip + 1}-${skip + productsToShow.length} จาก ${totalProducts} รายการ`, buttons);

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
        // Update derived stock
        product.stock = product.stockItems.length;

        await sendImageMessage(sender, product.imageUrl || "https://via.placeholder.com/300x200?text=Product");
        let detailText = `✨ ${product.name}\n`;
        detailText += `💰 ราคา: ฿${product.price}\n`;
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

        // Use derived stock count
        product.stock = product.stockItems.length;
        if (product.stock <= 0) return await sendMessage(sender, `ขออภัย ${product.name} หมดสต็อกแล้ว`);

        const user = getUserData(sender);
        const existingItemIndex = user.cart.findIndex(item => item.productId === productId);

        if (existingItemIndex > -1) {
            const currentQuantityInCart = user.cart[existingItemIndex].quantity;
            // Check if adding one more exceeds available stock
            if (currentQuantityInCart + 1 > product.stock) {
                return await sendMessage(sender, `ขออภัย เพิ่ม ${product.name} ไม่ได้แล้ว มีในสต็อกเพียง ${product.stock} ชิ้น (คุณมีในตะกร้า ${currentQuantityInCart} ชิ้น)`);
            }
            user.cart[existingItemIndex].quantity++;
            await sendMessage(sender, `✅ เพิ่มจำนวน ${product.name} เป็น ${user.cart[existingItemIndex].quantity} ชิ้นในตะกร้า`);
        } else {
            // Check if stock allows adding 1
             if (1 > product.stock) {
                 return await sendMessage(sender, `ขออภัย เพิ่ม ${product.name} ไม่ได้แล้ว มีในสต็อกเพียง ${product.stock} ชิ้น`);
             }
            user.cart.push({
                productId: productId,
                name: product.name,
                price: product.price,
                imageUrl: product.imageUrl,
                quantity: 1
                // Removed downloadUrl here, it's now product-level stockItems
            });
            await sendMessage(sender, `✅ เพิ่ม ${product.name} ลงตะกร้าเรียบร้อย`);
        }
        saveShopData(); // Save cart changes

        await sendButtonTemplate(sender, "ดำเนินการต่อ:", [
            { type: "postback", title: "🛒 ดูตะกร้า", payload: "CART_VIEW" },
            { type: "postback", title: `กลับไปหมวดหมู่ ${product.category}`, payload: `CATEGORY_${product.category}`},
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
            cartSummary += `${index + 1}. ${item.name} (฿${item.price} x ${item.quantity} = ฿${itemTotal})\n`;
            cartQuickReplies.push({
                content_type: "text",
                title: `ลบ ${item.name.substring(0,15)}${item.name.length > 15 ? '...' : ''}`,
                payload: `CART_REMOVE_${item.productId}`
            });
        });
        cartSummary += `\n💰 ยอดรวมทั้งสิ้น: ฿${totalAmount.toFixed(2)}`;
        await sendMessage(sender, cartSummary);

        if (cartQuickReplies.length < 12) cartQuickReplies.push({ content_type: "text", title: "ล้างตะกร้า", payload: "CART_CLEAR" });
        if (cartQuickReplies.length < 13) cartQuickReplies.push({ content_type: "text", title: "ชำระเงิน", payload: "CHECKOUT" });
        await sendQuickReplies(sender, "จัดการตะกร้าสินค้า:", cartQuickReplies);

        await sendButtonTemplate(sender, "เลือกดำเนินการต่อ:", [
            { type: "postback", title: "💰 ชำระเงิน", payload: "CHECKOUT" },
            { type: "postback", title: "เลือกซื้อเพิ่ม", payload: "SHOW_CATEGORIES" },
            { type: "postback", title: "ล้างตะกร้า", payload: "CART_CLEAR" }
        ]);

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
        await viewCart(sender);
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
// --- End Shop Logic Functions ---

// --- Checkout and Payment Processing (Modified for stockItems check & config) ---
async function checkout(sender) {
    try {
        const user = getUserData(sender);
        if (!user.cart || user.cart.length === 0) {
            await sendMessage(sender, "🛒 ตะกร้าของคุณว่างเปล่า ไม่สามารถชำระเงินได้");
            await sendButtonTemplate(sender, "เลือกซื้อสินค้ากัน!", [{ type: "postback", title: "เลือกหมวดหมู่", payload: "SHOW_CATEGORIES" }]);
            return;
        }

        let totalAmount = 0;
        let hasInsufficientStock = false;
        let stockIssues = [];

        // Verify stock availability again using stockItems.length
        for (const item of user.cart) {
            const product = shopData.products.find(p => p.id === item.productId);
            const availableStock = product ? product.stockItems.length : 0; // Check actual items
            if (!product || availableStock < item.quantity) {
                hasInsufficientStock = true;
                stockIssues.push(`${item.name} (ต้องการ ${item.quantity}, มี ${availableStock})`);
            } else {
                totalAmount += item.price * item.quantity;
            }
        }

        if (hasInsufficientStock) {
            await sendMessage(sender, `❌ ขออภัย มีสินค้าบางรายการในตะกร้าไม่เพียงพอ:\n- ${stockIssues.join('\n- ')}\nกรุณาปรับปรุงตะกร้าของคุณก่อน`);
            await viewCart(sender);
            return;
        }

        user.checkoutState = { step: 'select_method', totalAmount: totalAmount };
        saveShopData();

        await sendMessage(sender, `ยอดรวมที่ต้องชำระ: ฿${totalAmount.toFixed(2)}`);
        await sendMessage(sender, "กรุณาเลือกช่องทางการชำระเงิน หรือใช้โค้ดรับของ:");

        const paymentElements = [
            {
                title: "TrueMoney Wallet (ซองอั่งเปา)",
                subtitle: `สร้างและส่งซองอั่งเปามูลค่า ฿${totalAmount.toFixed(2)}`,
                image_url: loadedConfig.walletImage,
                buttons: [{ type: "postback", title: "เลือก Wallet", payload: "PAYMENT_ANGPAO" }]
            },
            {
                title: "โอนเงินผ่านธนาคาร",
                subtitle: `โอนเงิน ฿${totalAmount.toFixed(2)}\n${(loadedConfig.bankAccountDetails || '').split('\n')[0]}`, // Show bank name from config
                image_url: loadedConfig.bankImage,
                buttons: [{ type: "postback", title: "เลือก ธนาคาร", payload: "PAYMENT_BANK" }]
            },
            {
                title: "ใช้โค้ดรับของ",
                subtitle: "กรอกโค้ด 32 หลักที่คุณมี",
                image_url: loadedConfig.codeRedemptionImage,
                buttons: [{ type: "postback", title: "เลือกใช้โค้ด", payload: "PAYMENT_REDEEM_CODE" }]
            }
        ];
        await sendGenericTemplate(sender, paymentElements);
        await sendButtonTemplate(sender, "หากต้องการยกเลิก", [{ type: "postback", title: "❌ ยกเลิก", payload: "CANCEL_PAYMENT" }]);

    } catch (error) {
        console.error(`Error in checkout: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในขั้นตอนการชำระเงิน");
        const user = getUserData(sender);
        if (user.checkoutState) { delete user.checkoutState; saveShopData(); }
    }
}

async function processPaymentMethod(sender, method) {
    try {
        const user = getUserData(sender);
        if (!user.checkoutState || user.checkoutState.step !== 'select_method') {
            await sendMessage(sender, "สถานะไม่ถูกต้อง กรุณาเริ่มขั้นตอนชำระเงินใหม่");
            await checkout(sender);
            return;
        }

        const totalAmount = user.checkoutState.totalAmount;
        const cancelButton = { type: "postback", title: "❌ ยกเลิก", payload: "CANCEL_PAYMENT" };

        if (method === 'angpao') {
             if (!loadedConfig.walletPhone) return await sendMessage(sender, "❌ ขออภัย ไม่ได้ตั้งค่าเบอร์ Wallet ในระบบ กรุณาติดต่อแอดมิน");
            user.checkoutState.step = 'awaiting_angpao_link';
            user.checkoutState.paymentMethod = 'angpao';
            saveShopData();
            await sendMessage(sender, `📱 กรุณาสร้างซองอั่งเปา TrueMoney Wallet มูลค่า ฿${totalAmount.toFixed(2)}`);
            await sendButtonTemplate(sender, "จากนั้นส่ง 'ลิงก์ซองอั่งเปา' มาที่นี่", [cancelButton]);
        } else if (method === 'bank') {
             if (!loadedConfig.bankAccountDetails) return await sendMessage(sender, "❌ ขออภัย ไม่ได้ตั้งค่าข้อมูลบัญชีธนาคารในระบบ กรุณาติดต่อแอดมิน");
            user.checkoutState.step = 'awaiting_bank_slip';
            user.checkoutState.paymentMethod = 'bank';
            saveShopData();
            await sendMessage(sender, `🏦 กรุณาโอนเงินจำนวน ฿${totalAmount.toFixed(2)} มาที่บัญชี:`);
            await sendMessage(sender, loadedConfig.bankAccountDetails); // Use config value
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
        }
    } catch (error) {
        console.error(`Error processing payment method (${method}): ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาด โปรดลองเลือกวิธีชำระเงินอีกครั้ง");
        const user = getUserData(sender);
        if (user.checkoutState) { user.checkoutState.step = 'select_method'; saveShopData(); }
    }
}

async function handleCheckoutTextInput(sender, text) {
    try {
        const user = getUserData(sender);
        if (!user.checkoutState) return false;

        // --- Angpao Link ---
        if (user.checkoutState.step === 'awaiting_angpao_link') {
            const LINK_REGEX = /https:\/\/gift\.truemoney\.com\/campaign\/\?v=([a-zA-Z0-9]{35})/;
            const match = text.trim().match(LINK_REGEX);
            if (!match) {
                await sendMessage(sender, "⚠️ ลิงก์ซองอั่งเปาไม่ถูกต้อง กรุณาส่งลิงก์ที่ถูกต้อง");
                return true;
            }
            const angpaoLink = match[0];
            const recipientPhone = loadedConfig.walletPhone; // Use config value
            const expectedAmount = user.checkoutState.totalAmount;
            if (!recipientPhone) return await sendMessage(sender, "❌ ไม่ได้ตั้งค่าเบอร์ Wallet ในระบบ กรุณาติดต่อแอดมิน"), true;

            await sendMessage(sender, "⏳ กำลังตรวจสอบลิงก์ซองอั่งเปา...");
            const verificationResult = await verifyAngpaoLink(recipientPhone, angpaoLink, expectedAmount);
            if (verificationResult.success) {
                await sendMessage(sender, "✅ การชำระเงินผ่านซองอั่งเปาสำเร็จ!");
                await completeOrder(sender, 'angpao', angpaoLink);
            } else {
                await sendMessage(sender, `❌ ตรวจสอบล้มเหลว: ${verificationResult.message}`);
            }
            return true;
        }

        // --- Redemption Code ---
        if (user.checkoutState.step === 'awaiting_redeem_code') {
            const code = text.trim();
            const CODE_LENGTH = 32;
            if (code.length !== CODE_LENGTH) {
                await sendMessage(sender, `⚠️ โค้ดไม่ถูกต้อง กรุณาส่งโค้ด ${CODE_LENGTH} ตัวอักษร`);
                return true;
            }
            await sendMessage(sender, "⏳ กำลังตรวจสอบโค้ด...");
            const verificationResult = await verifyRedemptionCode(code);
            if (verificationResult.success) {
                await sendMessage(sender, "✅ โค้ดถูกต้อง!");
                // Remove code *before* completing order
                validRedemptionCodes = validRedemptionCodes.filter(c => c !== code);
                saveValidRedemptionCodes(); // Save immediately
                console.log(`Redemption code ${code} used by ${sender} and removed.`);
                await completeOrder(sender, 'redeem_code', code);
            } else {
                await sendMessage(sender, `❌ ตรวจสอบโค้ดล้มเหลว: ${verificationResult.message}`);
            }
             return true;
        }
        return false; // Not handled by checkout text input
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

        const expectedAmount = user.checkoutState.totalAmount;
        await sendMessage(sender, "⏳ ได้รับสลิปแล้ว กำลังตรวจสอบ...");
        const verificationResult = await verifyBankSlipXncly(sender, imageUrl, expectedAmount); // Use Xncly

        if (verificationResult.success) {
            await sendMessage(sender, "✅ การชำระเงินผ่านการโอนเงินสำเร็จ!");
            const confirmationData = verificationResult.confirmationData || imageUrl;
            await completeOrder(sender, 'bank', confirmationData);
        } else {
            await sendMessage(sender, `❌ ตรวจสอบสลิปล้มเหลว: ${verificationResult.message}`);
        }
        return true; // Handled
    } catch (error) {
        console.error(`Error in handleCheckoutImageInput: ${error.message}`);
        await sendMessage(sender, "❌ ขออภัย เกิดข้อผิดพลาดในการประมวลผลสลิป");
        await sendButtonTemplate(sender, "พบข้อผิดพลาด", [{ type: "postback", title: "❌ ยกเลิก", payload: "CANCEL_PAYMENT" }]);
        return true;
    }
}
// --- End Checkout Handling ---

// --- Payment Verification Functions (Modified for config) ---
async function verifyAngpaoLink(phoneToRedeem, voucherLink, expectedAmount) {
    const LINK_REGEX = /https:\/\/gift\.truemoney\.com\/campaign\/\?v=([a-zA-Z0-9]{35})/;
    const voucherHash = voucherLink.match(LINK_REGEX)?.[1];
    if (!voucherHash) return { success: false, message: 'รูปแบบลิงก์ซองอั่งเปาไม่ถูกต้อง' };
    if (!phoneToRedeem) return { success: false, message: 'ไม่ได้กำหนดเบอร์ Wallet ผู้รับในระบบ' };

    console.log(`Attempting Redeem: Hash=${voucherHash}, Phone=${phoneToRedeem}, Expected=฿${expectedAmount}`);
    // No typing indicator here as it's server-side action

    try {
        const response = await fetch(`https://gift.truemoney.com/campaign/vouchers/${voucherHash}/redeem`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ mobile: phoneToRedeem, voucher_hash: voucherHash }),
        });
        const data = await response.json();
        console.log("Angpao API Response:", JSON.stringify(data, null, 2));

        if (data.status?.code === 'SUCCESS') {
            const redeemedAmount = parseFloat(data.data?.my_ticket?.amount_baht);
            if (isNaN(redeemedAmount)) return { success: false, message: 'ไม่สามารถอ่านจำนวนเงินจากซองได้' };
            if (Math.abs(redeemedAmount - expectedAmount) < 0.01) {
                 return { success: true, message: 'การยืนยันสำเร็จ' };
            } else {
                console.warn(`Angpao amount mismatch: Redeemed ฿${redeemedAmount}, Expected ฿${expectedAmount}`);
                return { success: false, message: `จำนวนเงินในซอง (฿${redeemedAmount.toFixed(2)}) ไม่ตรงกับยอดที่ต้องชำระ (฿${expectedAmount.toFixed(2)}) โปรดติดต่อแอดมิน` };
            }
        } else {
            let errorMessage = data.status?.message || 'ไม่สามารถรับซองได้';
            if (errorMessage.includes("VOUCHER_OUT_OF_STOCK")) errorMessage = "ซองนี้ถูกใช้ไปหมดแล้ว";
            else if (errorMessage.includes("VOUCHER_NOT_FOUND")) errorMessage = "ไม่พบซองนี้ หรือลิงก์ไม่ถูกต้อง";
            else if (errorMessage.includes("TARGET_USER_HAS_ALREADY_REDEEMED")) errorMessage = "เบอร์ร้านค้ารับซองนี้ไปแล้ว";
            else if (errorMessage.includes("INTERNAL_ERROR") || errorMessage.includes("PROCESS_VOUCHER_FAILED")) errorMessage = "ระบบ TrueMoney ขัดข้อง";
            else if (errorMessage.includes("VOUCHER_EXPIRED")) errorMessage = "ซองนี้หมดอายุแล้ว";
            console.log("Angpao Redemption Failed:", errorMessage);
            return { success: false, message: `ไม่สามารถรับซองได้: ${errorMessage}` };
        }
    } catch (error) {
        console.error('Angpao Verification Network Error:', error);
        return { success: false, message: `เกิดข้อผิดพลาดเชื่อมต่อ TrueMoney: ${error.message || 'Network Error'}` };
    }
}

async function downloadImageToBuffer(imageUrl) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const protocol = imageUrl.startsWith('https') ? https : require('http');
        protocol.get(imageUrl, (response) => {
            if (response.statusCode !== 200) return reject(new Error(`Download fail: ${response.statusCode}`));
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', (err) => reject(new Error(`Download error: ${err.message}`)));
    });
}

async function verifyBankSlipXncly(sender, imageUrl, expectedAmount) {
    const clientIdSecret = loadedConfig.xnclyClientIdSecret;
    const checkUrl = loadedConfig.xnclyCheckUrl;
    if (!clientIdSecret || !clientIdSecret.includes(':')) return { success: false, message: 'ไม่ได้ตั้งค่า Xncly ClientID:Secret หรือรูปแบบไม่ถูกต้อง (ใน /admin/settings)' };
    if (!checkUrl) return { success: false, message: 'ไม่ได้ตั้งค่า Xncly CHECK_URL (ใน /admin/settings)' };

    console.log(`Verifying Slip (Xncly): URL=${imageUrl}, Expected=฿${expectedAmount}`);
    await sendTypingIndicator(sender, 'typing_on');

    try {
        await sendMessage(sender, "กำลังโหลดรูปสลิป...");
        const imageBuffer = await downloadImageToBuffer(imageUrl);
        console.log(`Downloaded buffer size: ${imageBuffer.length} bytes`);
        if (imageBuffer.length < 1000) console.warn("Downloaded image seems small.");
        await sendMessage(sender, "โหลดสำเร็จ กำลังส่งไปตรวจสอบ...");

        const formData = new FormData();
        formData.append('ClientID-Secret', clientIdSecret);
        formData.append('image', imageBuffer, { filename: 'slip.jpg', contentType: 'image/jpeg' });

        console.log("Sending slip to Xncly API...");
        const response = await axios.post(checkUrl, formData, {
            headers: formData.getHeaders(), timeout: 45000
        });
        const data = response.data;
        console.log("Xncly Slip API Response:", JSON.stringify(data, null, 2));

        if (data && data.status === true && data.result && data.result.amount !== undefined) {
            const slipAmount = parseFloat(data.result.amount);
            const slipReferenceId = data.result.reference_id;

            if (slipReferenceId) {
                console.log(`Xncly Slip Ref ID: ${slipReferenceId}`);
                if (verifiedSlips.includes(slipReferenceId)) {
                    console.warn(`Duplicate Slip Detected: Ref ID ${slipReferenceId} already used.`);
                    return { success: false, message: 'สลิปนี้ถูกใช้งานไปแล้ว (Ref ID ซ้ำ)' };
                }
            } else {
                console.warn("Xncly API did not return reference_id. Duplicate check skipped.");
            }

            if (isNaN(slipAmount)) return { success: false, message: 'ไม่สามารถอ่านจำนวนเงินจากสลิปได้' };
            console.log(`Xncly verification successful, Amount: ฿${slipAmount}`);

            if (Math.abs(slipAmount - expectedAmount) < 0.01) {
                if (slipReferenceId) {
                    verifiedSlips.push(slipReferenceId);
                    saveVerifiedSlips(); // Save immediately
                    console.log(`Stored verified slip Ref ID: ${slipReferenceId}`);
                }
                 return { success: true, message: 'การยืนยันสำเร็จ', confirmationData: slipReferenceId || `Verified ${slipAmount.toFixed(2)} THB` };
            } else {
                return { success: false, message: `จำนวนเงินในสลิป (฿${slipAmount.toFixed(2)}) ไม่ตรงกับยอดที่ต้องชำระ (฿${expectedAmount.toFixed(2)})` };
            }
        } else {
            let errorMessage = data?.message || 'ไม่สามารถตรวจสอบสลิปได้ (API Error)';
            console.error("Xncly Slip Check Failed:", errorMessage, data);
            if (errorMessage.includes("ClientID-Secret ไม่ถูกต้อง")) errorMessage = "ข้อมูล API ไม่ถูกต้อง (ตั้งค่าใน Admin)";
            else if (errorMessage.includes("Package expired") || errorMessage.includes("Invalid quota")) errorMessage = "โควต้าตรวจสอบสลิปหมด";
            else if (errorMessage.includes("Invalid image") || errorMessage.includes("Unable read QR")) errorMessage = "รูปสลิปไม่ถูกต้อง อ่านไม่ได้ หรือไม่ใช่สลิปที่รองรับ";
             else if (errorMessage.includes("Not support bank slip")) errorMessage = `สลิปจากธนาคารนี้ยังไม่รองรับ`;
            else if (errorMessage.includes("Duplicate slip")) errorMessage = 'ตรวจพบสลิปซ้ำในระบบของผู้ให้บริการ API';

            return { success: false, message: `ตรวจสอบล้มเหลว: ${errorMessage}` };
        }
    } catch (error) {
        console.error('Xncly Bank Slip Verification Error:', error);
        let friendlyMessage = "เกิดข้อผิดพลาดในการตรวจสอบสลิป";
        if (axios.isAxiosError(error)) {
             if (error.response) friendlyMessage = `เกิดข้อผิดพลาดจากระบบตรวจสอบ: ${error.response.data?.message || error.response.statusText}`;
             else if (error.request) friendlyMessage = "ไม่สามารถเชื่อมต่อระบบตรวจสอบสลิป";
             else friendlyMessage = `เกิดข้อผิดพลาดตั้งค่า Request: ${error.message}`;
             if (error.code === 'ECONNABORTED') friendlyMessage = "ระบบตรวจสอบสลิปใช้เวลานานเกินไป (Timeout)";
        } else friendlyMessage += `: ${error.message}`;
        return { success: false, message: friendlyMessage };
    } finally {
         await sendTypingIndicator(sender, 'typing_off');
    }
}

async function verifyRedemptionCode(code) {
    if (!code) return { success: false, message: 'ไม่ได้ระบุโค้ด' };
    console.log(`Verifying Redemption Code: ${code}`);
    const codeIndex = validRedemptionCodes.findIndex(validCode => validCode === code);
    if (codeIndex !== -1) {
        console.log(`Code ${code} is valid.`);
        return { success: true, message: 'โค้ดถูกต้อง' };
    } else {
        console.log(`Code ${code} is invalid or used.`);
        return { success: false, message: 'โค้ดไม่ถูกต้อง หรือถูกใช้ไปแล้ว' };
    }
}
// --- End Payment Verification ---

// --- Order Completion and Helper Functions (Modified for stockItems) ---

// Sends the specific stock item data to the user
async function sendDeliveredItemData(sender, productName, deliveredData) {
    await sendMessage(sender, `🎁 สินค้า: ${productName}`);
    if (deliveredData && deliveredData.trim()) {
        // Treat as text/code/link
         await sendMessage(sender, `🔑 ข้อมูล/โค้ด/ลิงก์:\n${deliveredData}`);
    } else {
        await sendMessage(sender, "⚠️ ไม่พบข้อมูลสำหรับสินค้านี้! กรุณาติดต่อแอดมิน");
    }
    await new Promise(resolve => setTimeout(resolve, 500)); // Short delay
}

async function completeOrder(sender, paymentMethod, paymentConfirmation) {
    try {
        const user = getUserData(sender);
        if (!user.checkoutState || !user.cart || user.cart.length === 0) {
            console.error(`Error in completeOrder: User ${sender} has no checkout state or cart.`);
            await sendMessage(sender, "เกิดข้อผิดพลาด: ไม่พบข้อมูลตะกร้าของคุณ โปรดติดต่อแอดมิน");
            if(user.checkoutState) { delete user.checkoutState; saveShopData(); }
            return;
        }

        const orderId = `ORD-${Date.now()}-${sender.slice(-4)}`;
        const orderItems = JSON.parse(JSON.stringify(user.cart)); // Deep copy cart
        let totalAmount = user.checkoutState.totalAmount || 0;
        let deliveredItemsData = []; // To store { productId, name, deliveredData: [...] }

        // --- Critical Section: Consume Stock Items ---
        let stockConsumptionError = false;
        for (const item of orderItems) {
            const productIndex = shopData.products.findIndex(p => p.id === item.productId);
            if (productIndex === -1) {
                 console.error(`FATAL: Product ${item.productId} not found during order completion for ${sender}.`);
                 stockConsumptionError = true;
                 await sendMessage(sender, `❌ เกิดข้อผิดพลาดร้ายแรง: ไม่พบสินค้า ${item.name} ในระบบขณะยืนยันคำสั่งซื้อ โปรดติดต่อแอดมินทันที!`);
                 break; // Stop processing this order
            }
            const product = shopData.products[productIndex];
            // Double-check stock again
            if (product.stockItems.length < item.quantity) {
                 console.error(`FATAL: Insufficient stock for ${product.name} (${item.quantity} needed, ${product.stockItems.length} avail) during completion for ${sender}.`);
                 stockConsumptionError = true;
                 await sendMessage(sender, `❌ ขออภัย ${product.name} มีสินค้าไม่พอในขณะยืนยันคำสั่งซื้อ! โปรดติดต่อแอดมิน`);
                 break; // Stop processing this order
            }

            // Pop items from stockItems
            const itemsForThisProduct = [];
            for (let i = 0; i < item.quantity; i++) {
                 const consumedItem = product.stockItems.pop(); // Remove from the end
                 if (!consumedItem) { // Should not happen if check above passed, but be safe
                     console.error(`FATAL: Popped undefined item for ${product.name} for order ${orderId}`);
                     stockConsumptionError = true;
                     await sendMessage(sender, `❌ เกิดข้อผิดพลาดร้ายแรงในการดึงข้อมูลสินค้า ${product.name} โปรดติดต่อแอดมิน!`);
                     // Attempt to put back already popped items for this product in this loop? Complex. Better to halt.
                     break;
                 }
                 itemsForThisProduct.push(consumedItem);
                 console.log(`Consumed stock item for ${product.name} (Order ${orderId}): ${consumedItem.substring(0, 10)}...`);
            }
             if (stockConsumptionError) break; // Exit outer loop too

            deliveredItemsData.push({
                productId: item.productId,
                name: item.name,
                deliveredData: itemsForThisProduct // Store the actual data delivered
            });
             // Update derived stock count immediately after popping
             product.stock = product.stockItems.length;
        }
        // --- End Critical Section ---

        // If any error occurred during stock consumption, do NOT save or proceed further
        if (stockConsumptionError) {
             // State might be inconsistent (some items popped).
             // Ideally, rollback, but that's complex. Log heavily.
             console.error(`Order ${orderId} for ${sender} halted due to stock consumption error. Data may be inconsistent. Manual check needed.`);
             // Do NOT clear cart or checkout state yet. Let admin investigate.
             await sendMessage(sender, "เกิดข้อผิดพลาดสำคัญ โปรดติดต่อแอดมินและแจ้งรหัสผู้ใช้ของคุณเพื่อตรวจสอบสถานะคำสั่งซื้อ");
             return;
        }

        // --- If stock consumption successful, proceed ---
        const newOrder = {
            id: orderId,
            userId: sender,
            items: deliveredItemsData, // Store the data that was actually delivered
            totalAmount: totalAmount,
            paymentMethod: paymentMethod,
            paymentStatus: 'paid',
            paymentConfirmation: paymentConfirmation,
            status: 'completed',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        // 1. Add order to the list
        shopData.orders.push(newOrder);

        // 2. Clear user's cart and checkout state
        user.cart = [];
        delete user.checkoutState;

        // 3. Save all changes (including popped stock items and new order)
        saveShopData(); // This now saves the modified product.stockItems

        console.log(`Order ${orderId} completed for user ${sender}. Payment: ${paymentMethod}`);

        // 4. Notify user and send items
        await sendMessage(sender, `🎉 ขอบคุณสำหรับการสั่งซื้อ!\nรหัสคำสั่งซื้อ: ${orderId}`);
        await sendMessage(sender, "✅ การชำระเงิน/ยืนยันโค้ดเรียบร้อย");
        await sendMessage(sender, "🚚 กำลังจัดส่งสินค้า...");

        await sendTypingIndicator(sender);
        for (const deliveredItem of deliveredItemsData) {
             for (const dataToSend of deliveredItem.deliveredData) {
                 await sendDeliveredItemData(sender, deliveredItem.name, dataToSend);
             }
        }
        await sendTypingIndicator(sender, 'typing_off');

        await sendMessage(sender, "✨ การจัดส่งเสร็จสมบูรณ์! หากมีปัญหา กรุณาติดต่อแอดมินพร้อมแจ้งรหัสคำสั่งซื้อ");
        await sendButtonTemplate(sender, "เลือกดูสินค้าอื่นๆ หรือติดต่อสอบถาม", [
            { type: "postback", title: "เลือกหมวดหมู่อื่น", payload: "SHOW_CATEGORIES" },
            { type: "web_url", title: "💬 ติดต่อแอดมิน", url: loadedConfig.adminContactLink || '#' }
        ]);

    } catch (error) {
        console.error(`Error in completeOrder for user ${sender}: ${error.message}`, error.stack);
        await sendMessage(sender, "❌ ขออภัย เกิดข้อผิดพลาดร้ายแรงในขั้นตอนสุดท้าย โปรดติดต่อแอดมินพร้อมแจ้งรหัสผู้ใช้ (PSID) ของคุณเพื่อตรวจสอบ");
         const user = getUserData(sender);
         if (user.checkoutState) { delete user.checkoutState; saveShopData(); } // Clean up state on error
    }
}

async function cancelPayment(sender) {
    try {
        const user = getUserData(sender);
        if (user.checkoutState) {
            const prevState = user.checkoutState.step;
            delete user.checkoutState;
            saveShopData();
            await sendMessage(sender, "✅ ยกเลิกขั้นตอนการชำระเงิน/ใช้โค้ดแล้ว");
            if (prevState && prevState !== 'select_method') await viewCart(sender);
            else await showCategories(sender);
        } else {
            await sendMessage(sender, "ไม่ได้อยู่ในขั้นตอนการชำระเงิน หรือใช้โค้ด");
        }
    } catch (error) {
        console.error(`Error in cancelPayment: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในการยกเลิก");
    }
}
// --- End Order Completion ---

// --- Search, Featured Products, Help Functions (Modified for config & stock) ---
async function searchProducts(sender, searchTerm) {
    try {
        if (!searchTerm || searchTerm.trim().length < 2) return await sendMessage(sender, "กรุณาระบุคำค้นหาอย่างน้อย 2 ตัวอักษร");
        const searchTermLower = searchTerm.toLowerCase().trim();
        const results = shopData.products.filter(product =>
            (product.name.toLowerCase().includes(searchTermLower) ||
             (product.description && product.description.toLowerCase().includes(searchTermLower)) ||
             (product.language && product.language.toLowerCase().includes(searchTermLower)) ||
             (product.category && product.category.toLowerCase().includes(searchTermLower)) ||
              product.id === searchTerm)
        );

        if (results.length === 0) {
            await sendMessage(sender, `⚠️ ไม่พบสินค้าที่ตรงกับ "${searchTerm}"`);
            await sendButtonTemplate(sender,"ลองค้นหาใหม่ หรือดูหมวดหมู่",[ { type: "postback", title: "ดูหมวดหมู่", payload: "SHOW_CATEGORIES" } ]);
            return;
        }

        // Update derived stock before display
        results.forEach(p => p.stock = p.stockItems.length);

        await sendMessage(sender, `🔎 ผลการค้นหาสำหรับ "${searchTerm}" (${results.length} รายการ):`);
        const elements = results.slice(0, 10).map(product => ({
            title: product.name + (product.stock <= 0 ? ' (หมด)' : ''),
            subtitle: `฿${product.price} | ${product.category} | เหลือ ${product.stock}`, // Use derived stock
            image_url: product.imageUrl || "https://via.placeholder.com/300x200?text=Result",
            buttons: [
                { type: "postback", title: "ดูรายละเอียด", payload: `PRODUCT_VIEW_${product.id}` },
                ...(product.stock > 0 ? [{ type: "postback", title: "➕ หยิบใส่ตะกร้า", payload: `PRODUCT_ADD_TO_CART_${product.id}` }] : [])
            ]
        }));
        await sendGenericTemplate(sender, elements);

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
        // Update derived stock first
        shopData.products.forEach(p => p.stock = p.stockItems.length);

        const featuredProducts = shopData.products
            .filter(p => p.stock > 0) // Use derived stock
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            .slice(0, 5);

        if (featuredProducts.length === 0) {
            await sendMessage(sender, "ตอนนี้ยังไม่มีสินค้าแนะนำพิเศษ");
            await showCategories(sender);
            return;
        }

        await sendMessage(sender, "🌟 สินค้าแนะนำ / มาใหม่ 🌟");
        const elements = featuredProducts.map(product => ({
            title: product.name,
            subtitle: `฿${product.price} | ${product.category} | เหลือ ${product.stock}`, // Use derived stock
            image_url: product.imageUrl || "https://via.placeholder.com/300x200?text=Featured",
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
        const helpText = `
🤖 คำสั่งช่วยเหลือ & ข้อมูล 🤖

🔹 **คำสั่งพื้นฐาน (พิมพ์ได้เลย):**
   - สินค้า / shop : แสดงหมวดหมู่
   - ตะกร้า / cart : ดูตะกร้า
   - ชำระเงิน / checkout : ไปยังหน้าชำระเงิน/ใช้โค้ด
   - แนะนำ / featured : ดูสินค้าแนะนำ
   - ค้นหา [คำ] : ค้นหาสินค้า
   - ล้างตะกร้า : ลบสินค้าในตะกร้า
   - ยกเลิก : ยกเลิกการชำระเงิน/ใช้โค้ด
   - ช่วยเหลือ / help : แสดงข้อความนี้

🔹 **การชำระเงิน/รับของ:**
   1. กด 'ชำระเงิน' จากตะกร้า
   2. เลือกวิธี: โอนเงิน (ส่งสลิป), Wallet (ส่งลิงก์ซอง), ใช้โค้ด (ส่งโค้ด 32 หลัก)
   3. ทำตามขั้นตอน ระบบจะส่งสินค้าให้เมื่อสำเร็จ

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

// --- Facebook Webhook Handling (GET/POST - Modified for config) ---
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    // Use verify token from loaded config
    if (mode && token && mode === 'subscribe' && token === loadedConfig.fbVerifyToken) {
        console.log('Webhook Verified');
        res.status(200).send(challenge);
    } else {
        console.error('Webhook Verification Failed. Mode:', mode, 'Token:', token, 'Expected:', loadedConfig.fbVerifyToken);
        if (!loadedConfig.fbVerifyToken || loadedConfig.fbVerifyToken === DEFAULT_CONFIG.fbVerifyToken) {
             console.error("----> Suggestion: Ensure 'Facebook Verify Token' is set correctly in /admin/settings and matches the one in your Facebook App's Webhook setup. <----");
        } else {
             console.error("----> Suggestion: Ensure the Verify Token in your Facebook App's Webhook setup matches the one configured in /admin/settings. <----");
        }
        res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    // Check Page Access Token before processing
     if (!loadedConfig.fbPageAccessToken) {
         console.error("Webhook Error: Facebook Page Access Token not configured. Cannot process incoming messages.");
         // Don't send error back to Facebook, just log and ignore.
         return res.sendStatus(200); // Acknowledge receipt but don't process
     }

    if (body.object === 'page') {
         if (!body.entry || !Array.isArray(body.entry)) {
             console.error("Invalid webhook payload: Missing or invalid 'entry'.");
             return res.sendStatus(400);
         }
        // Process entries asynchronously
        Promise.all(body.entry.map(async (entry) => {
            if (!entry.messaging || !Array.isArray(entry.messaging)) return;
            const webhook_event = entry.messaging[0];
            if (!webhook_event || !webhook_event.sender || !webhook_event.sender.id) return;
            const sender_psid = webhook_event.sender.id;
            console.log(`--- Event --- Sender PSID: ${sender_psid}`);

            try {
                 if (webhook_event.message) await handleMessage(sender_psid, webhook_event.message);
                 else if (webhook_event.postback) await handlePostback(sender_psid, webhook_event.postback);
                 // Ignore delivery/read receipts for simplicity
            } catch (error) {
                console.error(`Error processing event for ${sender_psid}:`, error);
            }
        })).then(() => {
            res.status(200).send('EVENT_RECEIVED');
        }).catch(err => {
            console.error("Error processing webhook batch:", err);
            res.status(500).send('INTERNAL_SERVER_ERROR');
        });
    } else {
        res.sendStatus(404);
    }
});
// --- End Webhook ---

// --- Message and Postback Handlers (Mostly Unchanged Internally) ---
async function handleMessage(sender_psid, received_message) {
    console.log(`Handling message from ${sender_psid}:`, JSON.stringify(received_message).substring(0, 150) + '...');
    const user = getUserData(sender_psid);

    // 1. Checkout Inputs (Text or Image)
    if (user.checkoutState) {
        if (received_message.text) {
            const handled = await handleCheckoutTextInput(sender_psid, received_message.text);
            if (handled) return;
        } else if (received_message.attachments?.[0]?.type === 'image' && received_message.attachments[0].payload?.url) {
            const handled = await handleCheckoutImageInput(sender_psid, received_message.attachments[0].payload.url);
            if (handled) return;
        } else if (received_message.attachments?.[0]?.type === 'fallback' && received_message.attachments[0].payload?.url) {
            const fallbackUrl = received_message.attachments[0].payload.url;
            const ANGPAO_REGEX = /https:\/\/gift\.truemoney\.com\/campaign\/\?v=([a-zA-Z0-9]{35})/;
            if (ANGPAO_REGEX.test(fallbackUrl)) {
                console.log('Angpao link detected from fallback attachment');
                const handled = await handleCheckoutTextInput(sender_psid, fallbackUrl);
                if (handled) return;
            } else {
                 // Remind user what's expected during checkout
                 if(user.checkoutState.step === 'awaiting_angpao_link') await sendMessage(sender_psid, "กรุณาส่ง 'ลิงก์ซองอั่งเปา' หรือกด 'ยกเลิก'");
                 else if(user.checkoutState.step === 'awaiting_bank_slip') await sendMessage(sender_psid, "กรุณาส่ง 'รูปสลิป' หรือกด 'ยกเลิก'");
                 else if(user.checkoutState.step === 'awaiting_redeem_code') await sendMessage(sender_psid, "กรุณาส่ง 'โค้ด 32 หลัก' หรือกด 'ยกเลิก'");
                 return;
            }
        } else if (received_message.text) { // Random text during checkout
             if (user.checkoutState.step === 'awaiting_angpao_link') await sendMessage(sender_psid, "กรุณาส่ง 'ลิงก์ซองอั่งเปา' หรือกด 'ยกเลิก'");
             else if (user.checkoutState.step === 'awaiting_bank_slip') await sendMessage(sender_psid, "กรุณาส่ง 'รูปสลิป' หรือกด 'ยกเลิก'");
             else if (user.checkoutState.step === 'awaiting_redeem_code') await sendMessage(sender_psid, "กรุณาส่ง 'โค้ด 32 หลัก' หรือกด 'ยกเลิก'");
             return;
        }
    }

    // 2. Quick Replies
    if (received_message.quick_reply?.payload) {
        console.log(`Quick Reply Payload: ${received_message.quick_reply.payload}`);
        await handlePostbackPayload(sender_psid, received_message.quick_reply.payload);
        return;
    }

    // 3. Attachments (Not handled by checkout)
    if (received_message.attachments?.length > 0) {
        const attachmentType = received_message.attachments[0].type;
        console.log(`Received unhandled attachment: ${attachmentType}`);
        if (attachmentType === 'image') await sendMessage(sender_psid, "ขอบคุณสำหรับรูปภาพครับ 👍 หากต้องการส่งสลิป กรุณาทำตามขั้นตอนชำระเงินก่อน");
        else await sendMessage(sender_psid, `ขอบคุณสำหรับไฟล์ ${attachmentType} ครับ 😊`);
        return;
    }

    // 4. Text Commands
    if (received_message.text) {
        let text = received_message.text.trim();
        const textLower = text.toLowerCase();
        console.log(`Received text: "${text}"`);

        if (['hi', 'hello', 'สวัสดี', 'หวัดดี'].includes(textLower)) {
            await sendMessage(sender_psid, "สวัสดีครับ! พิมพ์ 'สินค้า' เพื่อดูรายการ หรือ 'ช่วยเหลือ' เพื่อดูคำสั่งครับ 😊");
        } else if (['สินค้า', 'shop', 'menu'].includes(textLower)) await showCategories(sender_psid);
        else if (['ตะกร้า', 'cart'].includes(textLower)) await viewCart(sender_psid);
        else if (['ชำระเงิน', 'checkout'].includes(textLower)) await checkout(sender_psid);
        else if (['ช่วยเหลือ', 'help'].includes(textLower)) await showHelp(sender_psid);
        else if (['แนะนำ', 'featured'].includes(textLower)) await showFeaturedProducts(sender_psid);
        else if (['ล้างตะกร้า'].includes(textLower)) await clearCart(sender_psid);
        else if (['ยกเลิก', 'cancel'].includes(textLower)) await cancelPayment(sender_psid);
        else if (textLower.startsWith('ค้นหา ') || textLower.startsWith('search ')) {
             const searchTerm = text.substring(textLower.indexOf(' ')+1);
             await searchProducts(sender_psid, searchTerm);
        } else if (['ขอบคุณ', 'thanks', 'thank you'].includes(textLower)) {
             await sendMessage(sender_psid, "ยินดีเสมอครับ! 😊");
        } else {
            await sendMessage(sender_psid, `ขออภัย ไม่เข้าใจคำสั่ง "${text}"\nลองพิมพ์ 'ช่วยเหลือ' นะครับ`);
        }
    }
}

async function handlePostback(sender_psid, received_postback) {
    let payload = received_postback.payload;
    console.log(`Handling postback from ${sender_psid}, Payload: ${payload}`);
    await handlePostbackPayload(sender_psid, payload);
}

async function handlePostbackPayload(sender_psid, payload) {
    const user = getUserData(sender_psid);
    try {
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
             const page = parseInt(parts.pop());
             const categoryName = parts.join('_');
             if (!isNaN(page) && categoryName) await showProductsByCategory(sender_psid, categoryName, page);
             else console.error("Invalid MORE_PRODUCTS payload:", payload);
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
        else if (payload === 'PAYMENT_ANGPAO') await processPaymentMethod(sender_psid, 'angpao');
        else if (payload === 'PAYMENT_BANK') await processPaymentMethod(sender_psid, 'bank');
        else if (payload === 'PAYMENT_REDEEM_CODE') await processPaymentMethod(sender_psid, 'redeem_code');
        else if (payload === 'CANCEL_PAYMENT') await cancelPayment(sender_psid);
        else if (payload === 'HELP') await showHelp(sender_psid);
        else if (payload === 'FEATURED_PRODUCTS') await showFeaturedProducts(sender_psid);
        else {
            console.warn(`Unhandled payload: "${payload}"`);
            await sendMessage(sender_psid, "ขออภัย ไม่รู้จักคำสั่งนี้");
        }
    } catch (error) {
         console.error(`Error handling payload "${payload}" for ${sender_psid}:`, error);
         await sendMessage(sender_psid, "ขออภัย เกิดข้อผิดพลาด โปรดลองอีกครั้ง หรือติดต่อแอดมิน");
         if (user.checkoutState) await cancelPayment(sender_psid);
         else await showCategories(sender_psid);
    }
}
// --- End Handlers ---

// --- Admin Dashboard Setup and Routes (Modified for config & stockItems) ---
function validateImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const trimmedUrl = url.trim();
    const pattern = /^(https?:\/\/).+\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i;
    return pattern.test(trimmedUrl);
}

// Ensure admin directories exist
const viewsDir = path.join(__dirname, 'views');
if (!fs.existsSync(viewsDir)) fs.mkdirSync(viewsDir);
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

// --- Admin Routes ---
app.get('/admin', (req, res) => {
     try {
         // Ensure product stock counts are up-to-date for stats
         shopData.products.forEach(p => p.stock = p.stockItems.length);
        const stats = {
             totalProducts: shopData.products.length,
             totalCategories: shopData.categories.length,
             totalOrders: shopData.orders.length,
             completedOrders: shopData.orders.filter(o => o.status === 'completed').length,
             totalRevenue: shopData.orders
                             .filter(o => o.status === 'completed' && typeof o.totalAmount === 'number')
                             .reduce((sum, o) => sum + o.totalAmount, 0)
                             .toFixed(2),
             recentOrders: [...shopData.orders]
                           .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                           .slice(0, 5)
        };
        res.render('dashboard', { stats, pageTitle: 'Dashboard' }); // Pass title for navbar
     } catch (error) {
         console.error("Error rendering dashboard:", error);
         res.status(500).send("Error loading dashboard.");
     }
});

// --- Settings Route (NEW) ---
app.get('/admin/settings', (req, res) => {
    res.render('settings', { config: loadedConfig, message: req.query.message, pageTitle: 'Settings' });
});

app.post('/admin/settings/save', (req, res) => {
    try {
        // Update loadedConfig with form data
        loadedConfig.walletPhone = req.body.walletPhone?.trim() || '';
        loadedConfig.walletImage = req.body.walletImage?.trim() || DEFAULT_CONFIG.walletImage;
        loadedConfig.welcomeGif = req.body.welcomeGif?.trim() || DEFAULT_CONFIG.welcomeGif;
        loadedConfig.bankAccountDetails = req.body.bankAccountDetails?.trim() || '';
        loadedConfig.bankImage = req.body.bankImage?.trim() || DEFAULT_CONFIG.bankImage;
        loadedConfig.codeRedemptionImage = req.body.codeRedemptionImage?.trim() || DEFAULT_CONFIG.codeRedemptionImage;
        loadedConfig.xnclyClientIdSecret = req.body.xnclyClientIdSecret?.trim() || '';
        loadedConfig.xnclyCheckUrl = req.body.xnclyCheckUrl?.trim() || DEFAULT_CONFIG.xnclyCheckUrl;
        loadedConfig.fbVerifyToken = req.body.fbVerifyToken?.trim() || '';
        loadedConfig.fbPageAccessToken = req.body.fbPageAccessToken?.trim() || '';
        loadedConfig.adminContactLink = req.body.adminContactLink?.trim() || '';

        saveConfig(); // Save updated config to file
        console.log("Admin: Settings updated.");

        let message = "Settings saved successfully.";
        // Warn if critical tokens were changed and might require restart
        if (req.body.fbVerifyToken !== loadedConfig.fbVerifyToken || req.body.fbPageAccessToken !== loadedConfig.fbPageAccessToken) {
            // This comparison might not be perfect if initial load failed, but it's a hint
             message += " Note: Facebook Token changes may require a server restart to take full effect.";
        }

        res.redirect('/admin/settings?message=' + encodeURIComponent(message));
    } catch (error) {
        console.error("Error saving settings:", error);
        res.status(500).send("Error processing request.");
        res.redirect('/admin/settings?message=' + encodeURIComponent('Error saving settings: ' + error.message));
    }
});
// --- End Settings Route ---

app.get('/admin/products', (req, res) => {
     try {
         // Ensure derived stock is updated before rendering
         shopData.products.forEach(p => p.stock = p.stockItems.length);
        const sortedProducts = [...shopData.products].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        res.render('products', { products: sortedProducts, categories: shopData.categories, pageTitle: 'Products' });
     } catch (error) {
         console.error("Error rendering products page:", error);
         res.status(500).send("Error loading product data.");
     }
});

app.post('/admin/products/add', (req, res) => {
    try {
        const { name, price, category, description, language, version, imageUrl, stockItemsInput } = req.body; // Renamed stock to stockItemsInput

        // Basic Validation
        if (!name || !price || !category || !imageUrl || stockItemsInput === undefined) { // Check stockItemsInput
            return res.status(400).send('Missing required fields (Name, Price, Category, Image URL, Stock Items).');
        }
        if (isNaN(parseFloat(price)) || parseFloat(price) < 0) return res.status(400).send('Invalid price.');
        if (!validateImageUrl(imageUrl)) return res.status(400).send('Invalid image URL format.');
        if (!shopData.categories.some(cat => cat.name === category)) return res.status(400).send('Selected category does not exist.');

        // Process stockItemsInput: split by newline, trim, remove empty lines
        const stockItems = stockItemsInput.split('\n')
                                        .map(line => line.trim())
                                        .filter(line => line.length > 0);

        const newProduct = {
            id: `P-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            name: name.trim(),
            price: parseFloat(price),
            stockItems: stockItems, // Store the array of items
            stock: stockItems.length, // Derived stock count
            category: category,
            description: description ? description.trim() : '',
            language: language ? language.trim() : '',
            version: version ? version.trim() : '',
            imageUrl: imageUrl.trim(),
            // downloadUrl is removed, replaced by stockItems
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        shopData.products.push(newProduct);
        saveShopData();
        console.log(`Admin: Product added - ${newProduct.name} (ID: ${newProduct.id}) with ${newProduct.stock} stock items.`);
        res.redirect('/admin/products');
    } catch (error) {
        console.error("Error adding product:", error);
        res.status(500).send("Error processing request.");
    }
});

app.post('/admin/products/edit/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { name, price, category, description, language, version, imageUrl, stockItemsToAdd } = req.body; // Input for *adding* more items

        // Basic Validation
        if (!name || !price || !category || !imageUrl) return res.status(400).send('Missing required fields.');
        if (isNaN(parseFloat(price)) || parseFloat(price) < 0) return res.status(400).send('Invalid price.');
        if (!validateImageUrl(imageUrl)) return res.status(400).send('Invalid image URL format.');
        if (!shopData.categories.some(cat => cat.name === category)) return res.status(400).send('Selected category does not exist.');

        const productIndex = shopData.products.findIndex(p => p.id === id);
        if (productIndex === -1) return res.status(404).send('Product not found.');

        // Process stockItemsToAdd
        const itemsToAdd = stockItemsToAdd ? stockItemsToAdd.split('\n')
                                                  .map(line => line.trim())
                                                  .filter(line => line.length > 0) : [];

        const currentProduct = shopData.products[productIndex];
        const updatedStockItems = [...currentProduct.stockItems, ...itemsToAdd]; // Add new items to existing

        // Update product data
        currentProduct.name = name.trim();
        currentProduct.price = parseFloat(price);
        currentProduct.category = category;
        currentProduct.description = description ? description.trim() : '';
        currentProduct.language = language ? language.trim() : '';
        currentProduct.version = version ? version.trim() : '';
        currentProduct.imageUrl = imageUrl.trim();
        currentProduct.stockItems = updatedStockItems; // Update with combined list
        currentProduct.stock = updatedStockItems.length; // Update derived count
        currentProduct.updatedAt = new Date().toISOString();

        saveShopData();
        console.log(`Admin: Product edited - ${currentProduct.name} (ID: ${id}). Added ${itemsToAdd.length} items. Total stock: ${currentProduct.stock}`);
        res.redirect('/admin/products');
    } catch (error) {
        console.error(`Error editing product ${req.params.id}:`, error);
        res.status(500).send("Error processing request.");
    }
});

// NEW: Route to delete a specific stock item from a product
app.post('/admin/products/stock/delete/:productId/:itemIndex', (req, res) => {
    try {
        const { productId, itemIndex } = req.params;
        const index = parseInt(itemIndex, 10);

        const productIndex = shopData.products.findIndex(p => p.id === productId);
        if (productIndex === -1) return res.status(404).send('Product not found.');

        const product = shopData.products[productIndex];
        if (isNaN(index) || index < 0 || index >= product.stockItems.length) {
            return res.status(400).send('Invalid item index.');
        }

        const removedItem = product.stockItems.splice(index, 1)[0]; // Remove item at index
        product.stock = product.stockItems.length; // Update derived stock
        product.updatedAt = new Date().toISOString();
        saveShopData();

        console.log(`Admin: Deleted stock item at index ${index} ("${removedItem.substring(0,10)}...") from product ${productId}`);
        res.redirect('/admin/products'); // Redirect back to products list
    } catch (error) {
        console.error(`Error deleting stock item for product ${req.params.productId}:`, error);
        res.status(500).send("Error processing request.");
    }
});


app.post('/admin/products/delete/:id', (req, res) => {
    try {
        const { id } = req.params;
        const initialLength = shopData.products.length;
        shopData.products = shopData.products.filter(p => p.id !== id);

        if (shopData.products.length < initialLength) {
            saveShopData();
            console.log(`Admin: Product deleted - ID ${id}`);
            res.redirect('/admin/products');
        } else {
             res.status(404).send('Product not found.');
        }
    } catch (error) {
        console.error(`Error deleting product ${req.params.id}:`, error);
        res.status(500).send("Error processing request.");
    }
});

app.get('/admin/categories', (req, res) => {
     try {
        const categoriesWithCount = shopData.categories.map(cat => ({
            ...cat,
            productCount: shopData.products.filter(p => p.category === cat.name).length
        }));
         const error = req.query.error;
         const categoryName = req.query.categoryName; // Get category name for error message
         let errorMessage = '';
         if (error === 'delete_failed_in_use') {
             const catData = categoriesWithCount.find(c => c.name === decodeURIComponent(categoryName || ''));
             errorMessage = `ลบไม่สำเร็จ! ไม่สามารถลบหมวดหมู่ "${decodeURIComponent(categoryName || '')}" ได้เนื่องจากมีสินค้า (${catData?.productCount || '?'}) ใช้งานอยู่ กรุณาย้ายสินค้าออกก่อน`;
         }
        res.render('categories', { categories: categoriesWithCount, error: errorMessage, pageTitle: 'Categories' });
     } catch (error) {
         console.error("Error rendering categories page:", error);
         res.status(500).send("Error loading category data.");
     }
});

app.post('/admin/categories/add', (req, res) => {
    try {
        const { name, imageUrl, description } = req.body;
        if (!name || !name.trim()) return res.status(400).send('Category name required.');
        const trimmedName = name.trim();
        if (shopData.categories.some(cat => cat.name.toLowerCase() === trimmedName.toLowerCase())) {
             return res.status(400).send(`Category "${trimmedName}" already exists.`);
        }
        if (imageUrl && !validateImageUrl(imageUrl)) return res.status(400).send('Invalid image URL format.');

        shopData.categories.push({
            name: trimmedName,
            imageUrl: imageUrl ? imageUrl.trim() : '',
            description: description ? description.trim() : ''
        });
        shopData.categories.sort((a, b) => a.name.localeCompare(b.name));
        saveShopData();
        console.log(`Admin: Category added - ${trimmedName}`);
        res.redirect('/admin/categories');
    } catch (error) {
        console.error("Error adding category:", error);
        res.status(500).send("Error processing request.");
    }
});

app.post('/admin/categories/edit', (req, res) => {
    try {
        const { originalName, newName, imageUrl, description } = req.body;
        if (!originalName || !newName || !newName.trim()) return res.status(400).send('Names required.');
        const trimmedNewName = newName.trim();
        if (trimmedNewName.toLowerCase() !== originalName.toLowerCase() && shopData.categories.some(cat => cat.name.toLowerCase() === trimmedNewName.toLowerCase())) {
            return res.status(400).send(`Category name "${trimmedNewName}" already exists.`);
        }
        if (imageUrl && !validateImageUrl(imageUrl)) return res.status(400).send('Invalid image URL format.');

        const categoryIndex = shopData.categories.findIndex(cat => cat.name === originalName);
        if (categoryIndex === -1) return res.status(404).send('Category not found.');

        const oldName = shopData.categories[categoryIndex].name;
        shopData.categories[categoryIndex] = {
             name: trimmedNewName,
             imageUrl: imageUrl ? imageUrl.trim() : (shopData.categories[categoryIndex].imageUrl || ''),
             description: description ? description.trim() : (shopData.categories[categoryIndex].description || '')
        };

        if (trimmedNewName !== oldName) {
             let productsUpdated = 0;
             shopData.products.forEach(product => {
                 if (product.category === oldName) {
                     product.category = trimmedNewName;
                     product.updatedAt = new Date().toISOString();
                     productsUpdated++;
                 }
             });
             console.log(`Admin: Updated ${productsUpdated} products from category "${oldName}" to "${trimmedNewName}"`);
        }
        shopData.categories.sort((a, b) => a.name.localeCompare(b.name));
        saveShopData();
        console.log(`Admin: Category edited - "${oldName}" to "${trimmedNewName}"`);
        res.redirect('/admin/categories');
    } catch (error) {
        console.error("Error editing category:", error);
        res.status(500).send("Error processing request.");
    }
});

app.post('/admin/categories/delete/:name', (req, res) => {
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
            console.log(`Admin: Category deleted - ${decodedName}`);
            res.redirect('/admin/categories');
        } else {
            res.status(404).send('Category not found.');
        }
    } catch (error) {
        console.error(`Error deleting category ${decodeURIComponent(req.params.name)}:`, error);
        res.status(500).send("Error processing request.");
    }
});

app.get('/admin/orders', (req, res) => {
     try {
        const sortedOrders = [...shopData.orders]
                             .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.render('orders', { orders: sortedOrders, pageTitle: 'Orders' });
     } catch (error) {
         console.error("Error rendering orders page:", error);
         res.status(500).send("Error loading order data.");
     }
});

app.post('/admin/orders/status/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const validStatuses = ['pending', 'completed', 'cancelled', 'processing', 'shipped', 'refunded'];
        if (!validStatuses.includes(status)) return res.status(400).send('Invalid status.');

        const orderIndex = shopData.orders.findIndex(o => o.id === id);
        if (orderIndex !== -1) {
             if (shopData.orders[orderIndex].status !== status) {
                 shopData.orders[orderIndex].status = status;
                 shopData.orders[orderIndex].updatedAt = new Date().toISOString();
                 saveShopData();
                 console.log(`Admin: Order status updated - ID ${id} to ${status}`);
             }
             res.redirect('/admin/orders');
        } else {
            res.status(404).send('Order not found.');
        }
    } catch (error) {
        console.error(`Error updating order status ${req.params.id}:`, error);
        res.status(500).send("Error processing request.");
    }
});

app.get('/admin/codes', (req, res) => {
     try {
        const sortedCodes = [...validRedemptionCodes].sort();
        res.render('codes', { codes: sortedCodes, message: req.query.message, pageTitle: 'Redemption Codes' });
     } catch (error) {
         console.error("Error rendering codes page:", error);
         res.status(500).send("Error loading codes data.");
     }
});

app.post('/admin/codes/add', (req, res) => {
    try {
        let { code, count } = req.body;
        count = parseInt(count, 10) || 1;
        const CODE_LENGTH = 32;
        let addedCount = 0;
        let failedCodes = [];
        let message = '';

        if (code && code.trim()) {
            code = code.trim().toUpperCase(); // Standardize to uppercase
            if (code.length !== CODE_LENGTH) message = `Error: Manual code must be ${CODE_LENGTH} characters.`;
            else if (!/^[A-Z0-9]{32}$/.test(code)) message = `Error: Manual code must be uppercase letters or numbers only.`;
            else if (validRedemptionCodes.includes(code)) message = `Error: Code "${code}" already exists.`;
            else { validRedemptionCodes.push(code); addedCount++; }
        } else {
            if (count > 1000) count = 1000;
            if (count < 1) message = 'Error: Specify code or count (1-1000).';
            else {
                for (let i = 0; i < count; i++) {
                    let attempts = 0, generatedCode;
                    do {
                         generatedCode = crypto.randomBytes(16).toString('hex').toUpperCase();
                         attempts++;
                    } while (validRedemptionCodes.includes(generatedCode) && attempts < 10);
                    if (attempts < 10) { validRedemptionCodes.push(generatedCode); addedCount++; }
                    else { console.warn("Failed to generate unique code."); failedCodes.push(`Attempt ${i+1}`); }
                }
            }
        }

        if (addedCount > 0) {
             validRedemptionCodes.sort();
             saveValidRedemptionCodes();
             console.log(`Admin: Added ${addedCount} redemption code(s).`);
             message = `Successfully added ${addedCount} code(s).`;
             if (failedCodes.length > 0) message += ` Failed to generate ${failedCodes.length} unique code(s).`;
        } else if (!message) {
            message = "No codes added. Provide valid code or specify count.";
        }
        res.redirect(`/admin/codes?message=${encodeURIComponent(message)}`);
    } catch (error) {
        console.error("Error adding codes:", error);
        res.status(500).send("Error processing request.");
    }
});

app.post('/admin/codes/delete/:code', (req, res) => {
    try {
        const { code } = req.params; // Code from URL is already decoded
        const initialLength = validRedemptionCodes.length;
        validRedemptionCodes = validRedemptionCodes.filter(c => c !== code);

        if (validRedemptionCodes.length < initialLength) {
            saveValidRedemptionCodes();
            console.log(`Admin: Code deleted - ${code}`);
             res.redirect('/admin/codes?message=' + encodeURIComponent(`Code "${code}" deleted.`));
        } else {
            res.redirect('/admin/codes?message=' + encodeURIComponent(`Error: Code "${code}" not found.`));
        }
    } catch (error) {
        console.error(`Error deleting code ${req.params.code}:`, error);
        res.status(500).send("Error processing request.");
    }
});
// --- End Admin ---

// --- EJS Template Creation and File Checks (Modified) ---
// (Ensure template files exist or create them)
const templates = {
    // --- NAVBAR (Added Settings, active class based on pageTitle) ---
    'navbar.ejs': `
<nav class="navbar navbar-expand-lg navbar-dark bg-dark fixed-top shadow-sm">
  <div class="container">
    <a class="navbar-brand" href="/admin"><i class="bi bi-shield-lock"></i> Admin Panel</a>
    <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNavAdmin" aria-controls="navbarNavAdmin" aria-expanded="false" aria-label="Toggle navigation">
      <span class="navbar-toggler-icon"></span>
    </button>
    <div class="collapse navbar-collapse" id="navbarNavAdmin">
      <ul class="navbar-nav ms-auto mb-2 mb-lg-0">
        <li class="nav-item">
          <a class="nav-link <%= (typeof pageTitle !== 'undefined' && pageTitle === 'Dashboard') ? 'active' : '' %>" href="/admin"><i class="bi bi-speedometer2"></i> แดชบอร์ด</a>
        </li>
        <li class="nav-item">
          <a class="nav-link <%= (typeof pageTitle !== 'undefined' && pageTitle === 'Products') ? 'active' : '' %>" href="/admin/products"><i class="bi bi-box-seam"></i> สินค้า</a>
        </li>
        <li class="nav-item">
          <a class="nav-link <%= (typeof pageTitle !== 'undefined' && pageTitle === 'Categories') ? 'active' : '' %>" href="/admin/categories"><i class="bi bi-tags"></i> หมวดหมู่</a>
        </li>
        <li class="nav-item">
          <a class="nav-link <%= (typeof pageTitle !== 'undefined' && pageTitle === 'Orders') ? 'active' : '' %>" href="/admin/orders"><i class="bi bi-receipt"></i> คำสั่งซื้อ</a>
        </li>
        <li class="nav-item">
          <a class="nav-link <%= (typeof pageTitle !== 'undefined' && pageTitle === 'Redemption Codes') ? 'active' : '' %>" href="/admin/codes"><i class="bi bi-key"></i> โค้ดรับของ</a>
        </li>
        <li class="nav-item">
          <a class="nav-link <%= (typeof pageTitle !== 'undefined' && pageTitle === 'Settings') ? 'active' : '' %>" href="/admin/settings"><i class="bi bi-gear-fill"></i> ตั้งค่า</a>
        </li>
      </ul>
    </div>
  </div>
</nav>
`, // --- DASHBOARD (Unchanged from previous, add pageTitle) ---
    'dashboard.ejs': `
<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>แดชบอร์ด - Admin</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"><style>.card-icon{font-size:2.5rem}.card{transition:transform .2s ease-in-out}.card:hover{transform:translateY(-5px);box-shadow:0 4px 8px rgba(0,0,0,.1)}body{padding-top:70px;background-color:#f8f9fa}.card-footer span{margin-right:auto}.table th,.table td{vertical-align:middle}</style></head><body><%- include('navbar', { pageTitle: 'Dashboard' }) %><div class="container mt-4"><h2 class="mb-4"><i class="bi bi-speedometer2"></i> แดชบอร์ดภาพรวม</h2><div class="row g-4 mb-4"><div class="col-md-3 col-sm-6"><div class="card text-white bg-primary h-100"><div class="card-body d-flex justify-content-between align-items-center"><div><h5 class="card-title">สินค้าทั้งหมด</h5><h2 class="card-text display-6"><%= stats.totalProducts %></h2></div><i class="bi bi-box-seam card-icon opacity-75"></i></div><a href="/admin/products" class="card-footer text-white text-decoration-none d-flex justify-content-between align-items-center"><span>ดูรายละเอียด</span> <i class="bi bi-arrow-right-circle"></i></a></div></div><div class="col-md-3 col-sm-6"><div class="card text-white bg-info h-100"><div class="card-body d-flex justify-content-between align-items-center"><div><h5 class="card-title">หมวดหมู่</h5><h2 class="card-text display-6"><%= stats.totalCategories %></h2></div><i class="bi bi-tags card-icon opacity-75"></i></div><a href="/admin/categories" class="card-footer text-white text-decoration-none d-flex justify-content-between align-items-center"><span>ดูรายละเอียด</span> <i class="bi bi-arrow-right-circle"></i></a></div></div><div class="col-md-3 col-sm-6"><div class="card text-white bg-success h-100"><div class="card-body d-flex justify-content-between align-items-center"><div><h5 class="card-title">คำสั่งซื้อสำเร็จ</h5><h2 class="card-text display-6"><%= stats.completedOrders %> / <%= stats.totalOrders %></h2></div><i class="bi bi-cart-check card-icon opacity-75"></i></div><a href="/admin/orders" class="card-footer text-white text-decoration-none d-flex justify-content-between align-items-center"><span>ดูรายละเอียด</span> <i class="bi bi-arrow-right-circle"></i></a></div></div><div class="col-md-3 col-sm-6"><div class="card text-white bg-warning h-100"><div class="card-body d-flex justify-content-between align-items-center"><div><h5 class="card-title">รายรับรวม</h5><h3 class="card-text">฿<%= stats.totalRevenue %></h3></div><i class="bi bi-currency-bitcoin card-icon opacity-75"></i></div><div class="card-footer text-white"><small>จากคำสั่งซื้อที่สำเร็จ</small></div></div></div></div><div class="card mt-4"><div class="card-header bg-light"><h4><i class="bi bi-clock-history"></i> คำสั่งซื้อล่าสุด (5 รายการ)</h4></div><div class="card-body p-0"><div class="table-responsive"><table class="table table-striped table-hover mb-0"><thead class="table-light"><tr><th>รหัส</th><th>ลูกค้า (PSID)</th><th>ยอดรวม</th><th>ช่องทาง</th><th>สถานะ</th><th>วันที่</th></tr></thead><tbody><% if(stats.recentOrders.length > 0){ %><% stats.recentOrders.forEach(order => { %><tr><td><a href="/admin/orders#order-<%= order.id %>" title="<%= order.id %>"><%= order.id.slice(0,12) %>...</a></td><td><span title="<%= order.userId %>"><%= order.userId.slice(0,6) %>...<%= order.userId.slice(-4) %></span></td><td>฿<%= order.totalAmount.toFixed(2) %></td><td><%= order.paymentMethod %></td><td><span class="badge bg-<%= order.status === 'completed' ? 'success' : (order.status === 'cancelled' ? 'danger' : (order.status === 'pending' ? 'warning' : 'secondary')) %> text-capitalize"><%= order.status %></span></td><td><%= new Date(order.createdAt).toLocaleString('th-TH', {dateStyle:'short', timeStyle:'short'}) %></td></tr><% }) %><% } else { %><tr><td colspan="6" class="text-center text-muted py-3">ยังไม่มีคำสั่งซื้อ</td></tr><% } %></tbody></table></div></div><div class="card-footer text-end bg-light border-top-0"><a href="/admin/orders" class="btn btn-outline-primary btn-sm">ดูคำสั่งซื้อทั้งหมด <i class="bi bi-arrow-right"></i></a></div></div></div><script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script></body></html>
`, // --- PRODUCTS (Modified for stockItems textarea, stock display, add/edit forms) ---
    'products.ejs': `
<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>จัดการสินค้า - Admin</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"><style>.product-image-thumb{width:60px;height:60px;object-fit:cover;border-radius:4px}.image-preview{max-width:150px;max-height:100px;margin-top:10px;display:none;border:1px solid #ddd;padding:2px;border-radius:4px}th,td{vertical-align:middle}body{padding-top:70px;background-color:#f8f9fa}.btn-action form{display:inline}.stock-items-display{font-size:.8rem;color:#6c757d;max-height:60px;overflow-y:auto;display:block;white-space:pre-wrap;word-break:break-all}.stock-item-delete-btn{font-size:.7rem;padding:.1rem .3rem;line-height:1}</style></head><body><%- include('navbar', { pageTitle: 'Products' }) %><div class="container mt-4"><div class="d-flex justify-content-between align-items-center mb-3"><h2><i class="bi bi-box-seam"></i> จัดการสินค้า (<%= products.length %> รายการ)</h2><button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addProductModal"><i class="bi bi-plus-circle"></i> เพิ่มสินค้า</button></div><div class="card shadow-sm"><div class="card-body p-0"><div class="table-responsive"><table class="table table-striped table-hover mb-0"><thead class="table-light"><tr><th>รูป</th><th>ชื่อ</th><th>ราคา (฿)</th><th>คงเหลือ</th><th>หมวดหมู่</th><th>วันที่เพิ่ม/แก้ไข</th><th class="text-center">จัดการ</th></tr></thead><tbody><% if(products.length > 0){ %><% products.forEach(product => { %><tr><td><img src="<%= product.imageUrl %>" alt="Img" class="product-image-thumb" onerror="this.src='https://via.placeholder.com/60?text=N/A'"></td><td><%= product.name %><br><small class="text-muted">ID: <%= product.id %></small></td><td><%= product.price.toFixed(2) %></td><td><span class="badge fs-6 bg-<%= product.stock > 5 ? 'success' : (product.stock > 0 ? 'warning' : 'danger') %>" title="คลิกเพื่อแก้ไขสต็อก" data-bs-toggle="modal" data-bs-target="#editProductModal<%= product.id.replace(/[^a-zA-Z0-9]/g, '') %>" style="cursor:pointer;"><%= product.stock %></span></td><td><small><%= product.category %></small></td><td><small title="Created: <%= new Date(product.createdAt).toLocaleString('th-TH') %>\nUpdated: <%= new Date(product.updatedAt).toLocaleString('th-TH') %>"><%= new Date(product.updatedAt || product.createdAt).toLocaleDateString('th-TH', { year:'2-digit', month:'short', day:'numeric'}) %></small></td><td class="text-center btn-action"><button class="btn btn-sm btn-warning me-1" data-bs-toggle="modal" data-bs-target="#editProductModal<%= product.id.replace(/[^a-zA-Z0-9]/g, '') %>" title="แก้ไข"><i class="bi bi-pencil-square"></i></button><form method="POST" action="/admin/products/delete/<%= product.id %>"><button type="submit" class="btn btn-sm btn-danger" onclick="return confirm('ยืนยันลบสินค้า: <%= product.name %> ?')" title="ลบ"><i class="bi bi-trash3"></i></button></form></td></tr><% }) %><% } else { %><tr><td colspan="7" class="text-center text-muted py-3">ยังไม่มีสินค้าในระบบ</td></tr><% } %></tbody></table></div></div></div></div><!-- Add Product Modal --><div class="modal fade" id="addProductModal" tabindex="-1" aria-hidden="true"><div class="modal-dialog modal-lg"><div class="modal-content"><form method="POST" action="/admin/products/add"><div class="modal-header"><h5 class="modal-title">เพิ่มสินค้าใหม่</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body"><div class="row"><div class="col-md-8 mb-3"><label class="form-label">ชื่อสินค้า*</label><input type="text" name="name" class="form-control" required></div><div class="col-md-4 mb-3"><label class="form-label">ราคา (฿)*</label><input type="number" name="price" class="form-control" step="0.01" min="0" required></div></div><div class="mb-3"><label class="form-label">หมวดหมู่*</label><select name="category" class="form-select" required><option value="" disabled <%= categories.length === 0 ? '' : 'selected' %>>-- เลือก --</option><% categories.forEach(c => { %><option value="<%= c.name %>"><%= c.name %></option><% }) %><% if(categories.length === 0){ %><option disabled>!! กรุณาเพิ่มหมวดหมู่ก่อน !!</option><% } %></select></div><div class="mb-3"><label class="form-label">รายละเอียด</label><textarea name="description" class="form-control" rows="2"></textarea></div><div class="row"><div class="col-md-6 mb-3"><label class="form-label">ภาษา</label><input type="text" name="language" class="form-control"></div><div class="col-md-6 mb-3"><label class="form-label">เวอร์ชัน</label><input type="text" name="version" class="form-control"></div></div><div class="mb-3"><label class="form-label">URL รูปภาพ*</label><input type="url" name="imageUrl" class="form-control image-url-input" required placeholder="https://..."><img src="" class="image-preview"><div class="form-text text-muted">ต้องเป็น https และลงท้ายด้วย .jpg, .png, .gif, .webp</div></div><div class="mb-3"><label class="form-label">ข้อมูลสต็อกสินค้า (Stock Items)*</label><textarea name="stockItemsInput" class="form-control" required rows="5" placeholder="ใส่ข้อมูลที่จะส่งให้ลูกค้า 1 รายการ ต่อ 1 บรรทัด (เช่น โค้ด, ลิงก์ดาวน์โหลด)"></textarea><div class="form-text">จำนวนบรรทัด = จำนวนสต็อกเริ่มต้น</div></div></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button><button type="submit" class="btn btn-primary" <%= categories.length === 0 ? 'disabled' : '' %>>บันทึกสินค้า</button></div></form></div></div></div><!-- Edit Product Modals --><% products.forEach(product => { %><div class="modal fade" id="editProductModal<%= product.id.replace(/[^a-zA-Z0-9]/g, '') %>" tabindex="-1" aria-hidden="true"><div class="modal-dialog modal-xl"><div class="modal-content"><form method="POST" action="/admin/products/edit/<%= product.id %>"><div class="modal-header"><h5 class="modal-title">แก้ไขสินค้า: <%= product.name %></h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body"><div class="row"><div class="col-lg-7"><div class="row"><div class="col-md-8 mb-3"><label class="form-label">ชื่อ*</label><input type="text" name="name" class="form-control" value="<%= product.name %>" required></div><div class="col-md-4 mb-3"><label class="form-label">ราคา*</label><input type="number" name="price" class="form-control" step="0.01" min="0" value="<%= product.price %>" required></div></div><div class="mb-3"><label class="form-label">หมวดหมู่*</label><select name="category" class="form-select" required><% categories.forEach(c => { %><option value="<%= c.name %>" <%= c.name === product.category ? 'selected' : '' %>><%= c.name %></option><% }) %><% if(categories.length === 0){ %><option disabled>!! ไม่มีหมวดหมู่ !!</option><% } %></select></div><div class="mb-3"><label class="form-label">รายละเอียด</label><textarea name="description" class="form-control" rows="2"><%= product.description %></textarea></div><div class="row"><div class="col-md-6 mb-3"><label class="form-label">ภาษา</label><input type="text" name="language" class="form-control" value="<%= product.language || '' %>"></div><div class="col-md-6 mb-3"><label class="form-label">เวอร์ชัน</label><input type="text" name="version" class="form-control" value="<%= product.version || '' %>"></div></div><div class="mb-3"><label class="form-label">URL รูปภาพ*</label><input type="url" name="imageUrl" class="form-control image-url-input" value="<%= product.imageUrl %>" required><img src="<%= product.imageUrl %>" class="image-preview" style="display:block;"><div class="form-text text-muted">ต้องเป็น https และลงท้ายด้วย .jpg, .png, .gif, .webp</div></div></div><div class="col-lg-5"><div class="mb-3"><label class="form-label">รายการสต็อกปัจจุบัน (<%= product.stockItems.length %> รายการ)</label><div class="border rounded p-2 bg-light stock-items-display" style="max-height: 150px; overflow-y: auto;"><% if (product.stockItems.length > 0) { %><ul class="list-unstyled mb-0"><% product.stockItems.forEach((item, index) => { %><li class="d-flex justify-content-between align-items-center mb-1"><small class="me-2 text-truncate" title="<%= item %>"><%= index + 1 %>. <%= item %></small><form method="POST" action="/admin/products/stock/delete/<%= product.id %>/<%= index %>" class="d-inline" onsubmit="return confirm('ยืนยันลบสต็อกรายการที่ <%= index + 1 %> ?')"><button type="submit" class="btn btn-outline-danger btn-sm stock-item-delete-btn" title="ลบรายการนี้"><i class="bi bi-x-lg"></i></button></form></li><% }) %></ul><% } else { %><span class="text-muted">ไม่มีสต็อก</span><% } %></div></div><hr><div class="mb-3"><label class="form-label">เพิ่มสต็อก (Stock Items)</label><textarea name="stockItemsToAdd" class="form-control" rows="4" placeholder="ใส่ข้อมูลสต็อกที่จะเพิ่ม 1 รายการ ต่อ 1 บรรทัด"></textarea><div class="form-text">ข้อมูลที่เพิ่มจะต่อท้ายรายการเดิม</div></div></div></div></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button><button type="submit" class="btn btn-primary">บันทึกการเปลี่ยนแปลง</button></div></form></div></div></div><% }) %><script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script><script>document.addEventListener('DOMContentLoaded',function(){const t=e=>{const o=e.querySelector('.image-url-input'),n=e.querySelector('.image-preview');if(!o||!n)return;const i=()=>{const t=o.value.trim(),l=t&&/^(https?:\/\/).+\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(t);l?(n.src=t,n.style.display='block',o.classList.remove('is-invalid')):(n.style.display='none',t?o.classList.add('is-invalid'):o.classList.remove('is-invalid'))};o.addEventListener('input',i),i()};document.querySelectorAll('.modal').forEach(t)});</script></body></html>
`, // --- CATEGORIES (Modified, add pageTitle, improve error msg) ---
    'categories.ejs': `
<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>จัดการหมวดหมู่ - Admin</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"><style>.category-image-thumb{width:50px;height:50px;object-fit:cover;border-radius:4px;margin-right:10px;background-color:#eee}th,td{vertical-align:middle}.alert-tooltip{cursor:help}body{padding-top:70px;background-color:#f8f9fa}.btn-action form{display:inline}</style></head><body><%- include('navbar', { pageTitle: 'Categories' }) %><div class="container mt-4"><div class="d-flex justify-content-between align-items-center mb-3"><h2><i class="bi bi-tags"></i> จัดการหมวดหมู่ (<%= categories.length %> รายการ)</h2><button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addCategoryModal"><i class="bi bi-plus-circle"></i> เพิ่มหมวดหมู่</button></div><% if (typeof error !== 'undefined' && error) { %><div class="alert alert-danger alert-dismissible fade show" role="alert"><strong><i class="bi bi-exclamation-triangle-fill"></i> <%= error %></strong><button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div><% } %><div class="card shadow-sm"><div class="card-body p-0"><div class="table-responsive"><table class="table table-hover mb-0"><thead class="table-light"><tr><th>รูป</th><th>ชื่อหมวดหมู่</th><th>รายละเอียด</th><th class="text-center">สินค้า</th><th class="text-center">จัดการ</th></tr></thead><tbody><% if(categories.length > 0){ %><% categories.forEach(category => { %><tr><td><img src="<%= category.imageUrl || 'https://via.placeholder.com/50/dee2e6/6c757d?text=N/A' %>" alt="Img" class="category-image-thumb"></td><td><%= category.name %></td><td><small><%= category.description || '-' %></small></td><td class="text-center"><%= category.productCount %></td><td class="text-center btn-action"><button class="btn btn-sm btn-warning me-1" data-bs-toggle="modal" data-bs-target="#editCategoryModal<%= category.name.replace(/[^a-zA-Z0-9]/g, '') %>" title="แก้ไข"><i class="bi bi-pencil-square"></i></button><form method="POST" action="/admin/categories/delete/<%= encodeURIComponent(category.name) %>"><button type="submit" class="btn btn-sm btn-danger" <%= category.productCount > 0 ? 'disabled' : '' %> onclick="return confirm('ยืนยันลบหมวดหมู่: <%= category.name %> ? (ต้องไม่มีสินค้าในหมวดนี้)')" title="<%= category.productCount > 0 ? 'ไม่สามารถลบได้ มีสินค้าอยู่' : 'ลบหมวดหมู่' %>"><i class="bi bi-trash3"></i></button></form></td></tr><% }) %><% } else { %><tr><td colspan="5" class="text-center text-muted py-3">ยังไม่มีหมวดหมู่</td></tr><% } %></tbody></table></div></div></div></div><!-- Add Modal --><div class="modal fade" id="addCategoryModal" tabindex="-1" aria-hidden="true"><div class="modal-dialog"><div class="modal-content"><form method="POST" action="/admin/categories/add"><div class="modal-header"><h5 class="modal-title">เพิ่มหมวดหมู่ใหม่</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body"><div class="mb-3"><label class="form-label">ชื่อ*</label><input type="text" name="name" class="form-control" required></div><div class="mb-3"><label class="form-label">URL รูปภาพ</label><input type="url" name="imageUrl" class="form-control image-url-input" placeholder="https://..."><img src="" class="image-preview"><div class="form-text text-muted">https://... .jpg, .png, .gif, .webp</div></div><div class="mb-3"><label class="form-label">รายละเอียด</label><textarea name="description" class="form-control" rows="2"></textarea></div></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button><button type="submit" class="btn btn-primary">เพิ่ม</button></div></form></div></div></div><!-- Edit Modals --><% categories.forEach(category => { %><div class="modal fade" id="editCategoryModal<%= category.name.replace(/[^a-zA-Z0-9]/g, '') %>" tabindex="-1" aria-hidden="true"><div class="modal-dialog"><div class="modal-content"><form method="POST" action="/admin/categories/edit"><input type="hidden" name="originalName" value="<%= category.name %>"><div class="modal-header"><h5 class="modal-title">แก้ไข: <%= category.name %></h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body"><div class="mb-3"><label class="form-label">ชื่อใหม่*</label><input type="text" name="newName" class="form-control" value="<%= category.name %>" required></div><div class="mb-3"><label class="form-label">URL รูปภาพ</label><input type="url" name="imageUrl" class="form-control image-url-input" value="<%= category.imageUrl %>"><img src="<%= category.imageUrl %>" class="image-preview" style="<%= category.imageUrl ? 'display:block;' : '' %>"><div class="form-text text-muted">https://... .jpg, .png, .gif, .webp</div></div><div class="mb-3"><label class="form-label">รายละเอียด</label><textarea name="description" class="form-control" rows="2"><%= category.description %></textarea></div><div class="alert alert-warning small p-2"><i class="bi bi-exclamation-triangle-fill"></i> การเปลี่ยนชื่อ จะอัปเดตสินค้าในหมวดนี้อัตโนมัติ</div></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button><button type="submit" class="btn btn-primary">บันทึก</button></div></form></div></div></div><% }) %><script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script><script>document.addEventListener('DOMContentLoaded',function(){const t=e=>{const o=e.querySelector('.image-url-input'),n=e.querySelector('.image-preview');if(!o||!n)return;const i=()=>{const t=o.value.trim(),l=t&&/^(https?:\/\/).+\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(t);l?(n.src=t,n.style.display='block',o.classList.remove('is-invalid')):(n.style.display='none',n.src='',t?o.classList.add('is-invalid'):o.classList.remove('is-invalid'))};o.addEventListener('input',i)};document.querySelectorAll('.modal').forEach(t);const e=document.querySelector('.alert-danger');e&&setTimeout(()=>{new bootstrap.Alert(e).close()},10000)});</script></body></html>
`, // --- ORDERS (Modified to show deliveredData in items, add pageTitle) ---
    'orders.ejs': `
<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>จัดการคำสั่งซื้อ - Admin</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"><style>th,td{vertical-align:middle;font-size:.9rem}.item-list{list-style:none;padding-left:0;margin-bottom:0}.item-list li{font-size:.85rem}.item-list .delivered-data{font-size:.75rem;color:#6c757d;word-break:break-all;padding-left:1em}.status-select{min-width:120px}.order-row{border-left:4px solid transparent;transition:border-color .3s ease,background-color .3s ease}.order-row:target{border-left-color:#0d6efd;background-color:#e7f1ff;animation:highlight 1.5s ease-out}body{padding-top:70px;background-color:#f8f9fa}.confirmation-link{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:middle}@keyframes highlight{0%{background-color:#e7f1ff}100%{background-color:transparent}}</style></head><body><%- include('navbar', { pageTitle: 'Orders' }) %><div class="container mt-4"><h2><i class="bi bi-receipt"></i> จัดการคำสั่งซื้อ (<%= orders.length %> รายการ)</h2><div class="card mt-3 shadow-sm"><div class="card-body p-0"><div class="table-responsive"><table class="table table-hover table-bordered mb-0"><thead class="table-light"><tr><th>#</th><th>รหัสสั่งซื้อ</th><th>ลูกค้า</th><th>รายการสินค้า / ข้อมูลที่ส่ง</th><th>ยอด(฿)</th><th>ช่องทาง</th><th>สถานะ</th><th>วันที่</th><th>ข้อมูลยืนยัน</th></tr></thead><tbody><% if(orders.length > 0){ %><% orders.forEach((order, index) => { %><tr class="order-row" id="order-<%= order.id %>"><td><%= index + 1 %></td><td><small title="<%= order.id %>"><%= order.id.substring(0,16) %>...</small></td><td><small title="<%= order.userId %>"><%= order.userId.substring(0,6) %>...<%= order.userId.slice(-4) %></small></td><td><ul class="item-list"><% order.items.forEach(item => { %><li><small><b><%= item.name %></b></small><% if(item.deliveredData && item.deliveredData.length > 0) { %><% item.deliveredData.forEach((data, dataIdx) => { %><div class="delivered-data" title="Data sent: <%= data %>"><i class="bi bi-arrow-return-right"></i> <%= data.substring(0, 30) %><% if(data.length > 30) { %>...<% } %></div><% }) %><% } else { %><div class="delivered-data text-danger">(ไม่ได้ส่งข้อมูล?)</div><% } %></li><% }) %></ul></td><td><b><%= order.totalAmount.toFixed(2) %></b></td><td><span class="badge bg-<%= order.paymentMethod==='angpao'?'danger':order.paymentMethod==='bank'?'info':order.paymentMethod==='redeem_code'?'primary':'secondary' %> text-capitalize"><i class="bi bi-<%= order.paymentMethod==='angpao'?'gift':order.paymentMethod==='bank'?'bank':order.paymentMethod==='redeem_code'?'key':'question-circle' %>"></i> <%= order.paymentMethod %></span></td><td><form method="POST" action="/admin/orders/status/<%= order.id %>" class="d-inline-block"><select name="status" class="form-select form-select-sm status-select" onchange="this.form.submit()" title="เปลี่ยนสถานะ"><option value="pending" <%=order.status==='pending'?'selected':'' %>>⏳ รอดำเนินการ</option><option value="processing" <%=order.status==='processing'?'selected':'' %>>🔄 กำลังเตรียม</option><option value="completed" <%=order.status==='completed'?'selected':'' %>>✔️ สำเร็จ</option><option value="cancelled" <%=order.status==='cancelled'?'selected':'' %>>❌ ยกเลิก</option><option value="shipped" <%=order.status==='shipped'?'selected':'' %>>🚚 จัดส่งแล้ว</option><option value="refunded" <%=order.status==='refunded'?'selected':'' %>>💸 คืนเงิน</option></select></form></td><td><small title="Updated: <%= new Date(order.updatedAt).toLocaleString('th-TH') %>"><%= new Date(order.createdAt).toLocaleString('th-TH', { dateStyle:'short', timeStyle:'short'}) %></small></td><td class="text-center"><% if(order.paymentConfirmation && (order.paymentConfirmation.startsWith('http'))){ %><a href="<%= order.paymentConfirmation %>" target="_blank" class="btn btn-sm btn-outline-secondary confirmation-link" title="ดู: <%= order.paymentConfirmation %>"><i class="bi bi-link-45deg"></i> ลิงก์/สลิป</a><% } else if(order.paymentConfirmation){ %><span class="badge bg-light text-dark" title="Ref: <%= order.paymentConfirmation %>"><small><%= order.paymentConfirmation.substring(0,15) %>...</small></span><% } else { %> <span class="text-muted">-</span> <% } %></td></tr><% }) %><% } else { %><tr><td colspan="9" class="text-center text-muted py-3">ยังไม่มีคำสั่งซื้อ</td></tr><% } %></tbody></table></div></div></div></div><script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script><script>document.addEventListener('DOMContentLoaded',function(){if(window.location.hash){const e=document.querySelector(window.location.hash);e&&(e.scrollIntoView({behavior:'smooth',block:'center'}),e.classList.add('highlight-target'))}});</script></body></html>
`, // --- CODES (Modified, add pageTitle, standardize code input) ---
    'codes.ejs': `
<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>จัดการโค้ดรับของ - Admin</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"><style>body{padding-top:70px;background-color:#f8f9fa}.code-list{max-height:60vh;overflow-y:auto}.code-item{font-family:monospace;word-break:break-all}</style></head><body><%- include('navbar', { pageTitle: 'Redemption Codes' }) %><div class="container mt-4"><div class="d-flex justify-content-between align-items-center mb-3"><h2><i class="bi bi-key-fill"></i> จัดการโค้ดรับของ (<%= codes.length %> โค้ด)</h2><button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addCodeModal"><i class="bi bi-plus-circle"></i> เพิ่ม/สร้างโค้ด</button></div><% if(typeof message !== 'undefined' && message){ %><div class="alert alert-info alert-dismissible fade show" role="alert"><i class="bi bi-info-circle-fill"></i> <%= message %><button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div><% } %><div class="card shadow-sm"><div class="card-header bg-light">รายการโค้ด (32 ตัวอักษร A-Z, 0-9)</div><div class="card-body"><% if(codes.length > 0){ %><div class="code-list border rounded p-3 mb-3"><ul class="list-group list-group-flush"><% codes.forEach(code => { %><li class="list-group-item d-flex justify-content-between align-items-center"><span class="code-item"><%= code %></span><form method="POST" action="/admin/codes/delete/<%= code %>" class="ms-2"><button type="submit" class="btn btn-sm btn-outline-danger" onclick="return confirm('ยืนยันลบโค้ด: <%= code %> ?')" title="ลบโค้ดนี้"><i class="bi bi-trash3"></i></button></form></li><% }) %></ul></div><p class="text-muted small">โค้ดที่ใช้แล้วจะถูกลบอัตโนมัติ</p><% } else { %><p class="text-center text-muted py-3">ยังไม่มีโค้ดรับของในระบบ</p><% } %></div></div></div><!-- Add Code Modal --><div class="modal fade" id="addCodeModal" tabindex="-1" aria-hidden="true"><div class="modal-dialog"><div class="modal-content"><form method="POST" action="/admin/codes/add"><div class="modal-header"><h5 class="modal-title">เพิ่ม หรือ สร้างโค้ด</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body"><div class="mb-3"><label for="manualCode" class="form-label">เพิ่มโค้ดเอง (32 ตัว)</label><input type="text" name="code" id="manualCode" class="form-control text-uppercase" pattern="[A-Z0-9]{32}" title="ต้องเป็น A-Z หรือ 0-9 จำนวน 32 ตัว" placeholder="เว้นว่างเพื่อสร้างอัตโนมัติ"><div class="form-text">ตัวอักษรพิมพ์เล็กจะถูกแปลงเป็นพิมพ์ใหญ่</div></div><hr><div class="mb-3"><label for="generateCount" class="form-label">สร้างอัตโนมัติ (จำนวน)</label><input type="number" name="count" id="generateCount" class="form-control" min="1" max="1000" value="10"><div class="form-text">ระบุจำนวน (1-1000) ระบบจะสร้างให้หากช่องบนเว้นว่าง</div></div></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button><button type="submit" class="btn btn-primary">เพิ่ม/สร้าง</button></div></form></div></div></div><script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script><script>document.addEventListener('DOMContentLoaded',function(){const t=document.querySelector('.alert-info');t&&setTimeout(()=>{new bootstrap.Alert(t).close()},7000)});</script></body></html>
`, // --- NEW: SETTINGS ---
    'settings.ejs': `
<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>ตั้งค่าระบบ - Admin</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"><style>body{padding-top:70px;background-color:#f8f9fa}textarea{font-family:monospace}.form-text{font-size:.875em}</style></head><body><%- include('navbar', { pageTitle: 'Settings' }) %><div class="container mt-4"><div class="d-flex justify-content-between align-items-center mb-3"><h2><i class="bi bi-gear-fill"></i> ตั้งค่าระบบ</h2></div><% if (typeof message !== 'undefined' && message) { %><div class="alert alert-success alert-dismissible fade show" role="alert"><i class="bi bi-check-circle-fill"></i> <%= message %><button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div><% } %><form method="POST" action="/admin/settings/save"><div class="card shadow-sm mb-4"><div class="card-header"><strong><i class="bi bi-facebook"></i> Facebook Messenger</strong></div><div class="card-body"><div class="row"><div class="col-md-6 mb-3"><label for="fbVerifyToken" class="form-label">Verify Token*</label><input type="text" class="form-control" id="fbVerifyToken" name="fbVerifyToken" value="<%= config.fbVerifyToken %>" required><div class="form-text">ต้องตรงกับที่ตั้งใน Facebook App Webhook setup</div></div><div class="col-md-6 mb-3"><label for="adminContactLink" class="form-label">ลิงก์ติดต่อแอดมิน*</label><input type="url" class="form-control" id="adminContactLink" name="adminContactLink" value="<%= config.adminContactLink %>" placeholder="https://m.me/YOUR_PAGE_ID" required><div class="form-text">ลิงก์ m.me สำหรับปุ่มติดต่อแอดมิน</div></div></div><div class="mb-3"><label for="fbPageAccessToken" class="form-label">Page Access Token*</label><textarea class="form-control" id="fbPageAccessToken" name="fbPageAccessToken" rows="3" required><%= config.fbPageAccessToken %></textarea><div class="form-text">Token ที่สร้างจาก Facebook App สำหรับเพจของคุณ</div></div><div class="mb-3"><label for="welcomeGif" class="form-label">Welcome GIF URL</label><input type="url" class="form-control" id="welcomeGif" name="welcomeGif" value="<%= config.welcomeGif %>"><div class="form-text">URL รูป GIF ต้อนรับ (ถ้ามี)</div></div></div></div><div class="card shadow-sm mb-4"><div class="card-header"><strong><i class="bi bi-wallet2"></i> TrueMoney Wallet (Angpao)</strong></div><div class="card-body"><div class="row"><div class="col-md-6 mb-3"><label for="walletPhone" class="form-label">เบอร์ Wallet ร้านค้า (สำหรับรับซอง)*</label><input type="text" class="form-control" id="walletPhone" name="walletPhone" value="<%= config.walletPhone %>" pattern="[0-9]{10}" title="ใส่เบอร์โทรศัพท์ 10 หลัก" required><div class="form-text">เบอร์ TrueMoney ที่ใช้รับเงินจากซองอั่งเปา</div></div><div class="col-md-6 mb-3"><label for="walletImage" class="form-label">Wallet Image URL</label><input type="url" class="form-control" id="walletImage" name="walletImage" value="<%= config.walletImage %>"><div class="form-text">URL รูปภาพสำหรับตัวเลือกจ่ายผ่าน Wallet</div></div></div></div></div><div class="card shadow-sm mb-4"><div class="card-header"><strong><i class="bi bi-bank"></i> Bank Transfer</strong></div><div class="card-body"><div class="mb-3"><label for="bankAccountDetails" class="form-label">ข้อมูลบัญชีธนาคาร*</label><textarea class="form-control" id="bankAccountDetails" name="bankAccountDetails" rows="4" required><%= config.bankAccountDetails %></textarea><div class="form-text">แสดงให้ลูกค้าเห็นตอนเลือกโอนเงิน (ใส่ ธนาคาร, เลขบัญชี, ชื่อบัญชี)</div></div><div class="mb-3"><label for="bankImage" class="form-label">Bank Logo Image URL</label><input type="url" class="form-control" id="bankImage" name="bankImage" value="<%= config.bankImage %>"><div class="form-text">URL รูปโลโก้ธนาคาร</div></div></div></div><div class="card shadow-sm mb-4"><div class="card-header"><strong><i class="bi bi-receipt"></i> Xncly Slip Check API</strong></div><div class="card-body"><div class="mb-3"><label for="xnclyClientIdSecret" class="form-label">Xncly ClientID:Secret*</label><input type="text" class="form-control" id="xnclyClientIdSecret" name="xnclyClientIdSecret" value="<%= config.xnclyClientIdSecret %>" placeholder="ClientID:Secret" required><div class="form-text">รูปแบบ ClientID:Secret จาก <a href="https://xncly.xyz/" target="_blank">xncly.xyz</a></div></div><div class="mb-3"><label for="xnclyCheckUrl" class="form-label">Xncly Check URL*</label><input type="url" class="form-control" id="xnclyCheckUrl" name="xnclyCheckUrl" value="<%= config.xnclyCheckUrl %>" required></div></div></div><div class="card shadow-sm mb-4"><div class="card-header"><strong><i class="bi bi-key-fill"></i> Code Redemption</strong></div><div class="card-body"><div class="mb-3"><label for="codeRedemptionImage" class="form-label">Code Redemption Image URL</label><input type="url" class="form-control" id="codeRedemptionImage" name="codeRedemptionImage" value="<%= config.codeRedemptionImage %>"><div class="form-text">URL รูปภาพสำหรับตัวเลือกใช้โค้ด</div></div></div></div><div class="text-center mb-4"><button type="submit" class="btn btn-primary btn-lg"><i class="bi bi-save"></i> บันทึกการตั้งค่า</button></div></form></div><script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script><script>document.addEventListener('DOMContentLoaded',function(){const t=document.querySelector('.alert-success');t&&setTimeout(()=>{new bootstrap.Alert(t).close()},7000)});</script></body></html>
`
};

Object.entries(templates).forEach(([filename, content]) => {
    const filepath = path.join(viewsDir, filename);
    try {
        fs.mkdirSync(path.dirname(filepath), { recursive: true });
        fs.writeFileSync(filepath, content.trim(), 'utf8');
        console.log(`Admin template '${filename}' created/updated.`);
    } catch (error) {
        console.error(`Error writing template ${filename}:`, error);
    }
});
// --- End EJS Setup ---

// --- Server Startup ---
const PORT = process.env.PORT || (useHttps ? 8443 : 3000);

if (useHttps && credentials.key && credentials.cert) {
    const httpsServer = https.createServer(credentials, app);
    httpsServer.listen(PORT, () => {
        const domainMatch = certificatePath.match(/live\/([^\/]+)\//); // Attempt to extract domain from cert path
        const domain = domainMatch ? domainMatch[1] : 'YOUR_DOMAIN.COM'; // Fallback needed
        console.log(`---------------------------------------------------`);
        console.log(`✅ HTTPS Server running on port ${PORT}`);
        console.log(`🔗 Admin Dashboard: https://${domain}:${PORT}/admin`);
        console.log(`🔗 Webhook URL:     https://${domain}:${PORT}/webhook`);
        console.log(`   (Ensure this matches Facebook App Webhook settings)`);
        console.log(`---------------------------------------------------`);
        if (loadedConfig.fbVerifyToken === DEFAULT_CONFIG.fbVerifyToken || !loadedConfig.fbPageAccessToken || !loadedConfig.walletPhone || !loadedConfig.xnclyClientIdSecret) {
            console.warn("⚠️ WARNING: Essential settings missing in config.json. Please configure via /admin/settings!");
        }
    });
} else {
    app.listen(PORT, () => {
        console.warn(`---------------------------------------------------`);
        console.warn(`⚠️ Running HTTP server on port ${PORT}. HTTPS highly recommended!`);
        console.warn(`🔗 Admin Dashboard (HTTP): http://localhost:${PORT}/admin`);
        console.warn(`🔗 Webhook URL (HTTP): Needs tunneling (e.g., ngrok) for Facebook.`);
        console.warn(`   Example (ngrok): https://<your-ngrok-id>.ngrok.io/webhook`);
        console.warn(`---------------------------------------------------`);
        if (loadedConfig.fbVerifyToken === DEFAULT_CONFIG.fbVerifyToken || !loadedConfig.fbPageAccessToken || !loadedConfig.walletPhone || !loadedConfig.xnclyClientIdSecret) {
            console.warn("⚠️ WARNING: Essential settings missing in config.json. Please configure via /admin/settings!");
        }
    });
}


// --- Initial File Creation Checks ---
function createInitialFiles() {
    // Check/Create config.json (handled by loadConfig)
    if (!fs.existsSync(CONFIG_FILE)) saveConfig(); // Creates with defaults if missing

    const filesToCreate = {
        'package.json': () => JSON.stringify({
            "name": "fb-messenger-shop-v3-config",
            "version": "3.0.0",
            "description": "Facebook Messenger Bot shop with Angpao, Xncly Slip, Code Redemption, Quantity Stock, and Web Config",
            "main": "index.js", // Assuming filename is index.js
            "scripts": { "start": "node index.js" },
            "dependencies": {
                "axios": "^1.6.8", "body-parser": "^1.20.2", "ejs": "^3.1.9",
                "express": "^4.18.2", "form-data": "^4.0.0", "request": "^2.88.2"
            }, "engines": { "node": ">=16.0.0" }
        }, null, 2),
        'README.md': () => `# FB Messenger Shop Bot (v3.0.0 - Web Config & Quantity Stock)\n\nFeatures:\n*   TrueMoney Angpao (Auto Redeem)\n*   Bank Transfer (Xncly Slip Verification + Duplicate Check)\n*   Code Redemption (32-char codes)\n*   **Quantity-Based Stock:** Each item has unique data (code/link) consumed on purchase.\n*   **Web-Based Configuration:** Manage Tokens, API keys, Bank/Wallet info via \`/admin/settings\`.\n*   Admin Dashboard: Manage products (incl. stock items), categories, orders, redemption codes, settings.\n\n## Setup\n\n1.  **Install:** \`npm install\`\n2.  **Configure:**\n    *   Run the bot once (\`npm start\`) to generate initial \`config.json\`.\n    *   Access the Admin Panel (\`/admin\`, default: \`http://localhost:3000/admin\` or \`https://your.domain:8443/admin\`).\n    *   Go to **Settings** (\`/admin/settings\`) and fill in ALL required fields (Tokens, API Keys, Wallet/Bank info).\n    *   **IMPORTANT:** Restart the bot after saving settings, especially after changing Facebook Tokens.\n    *   (Optional) Set up SSL certificates for HTTPS (recommended, edit paths in script if needed).\n3.  **Facebook App:**\n    *   Setup Messenger Platform integration.\n    *   Add Webhook: URL from server startup logs (e.g., \`https://your.domain:8443/webhook\`), Verify Token from \`/admin/settings\`.\n    *   Subscribe to \`messages\`, \`messaging_postbacks\`.\n    *   Ensure Page Access Token in \`/admin/settings\` is correct.\n4.  **Add Content:** Use the admin panel to add categories, products (including their unique stock items), and redemption codes.\n5.  **Run:** \`npm start\`\n\n## Security\n\n**The admin panel (\`/admin\`) has NO built-in password protection.** You MUST secure it yourself (e.g., using basic auth middleware, IP filtering, or placing it behind a protected gateway) if deploying publicly.`,
        '.gitignore': () => `node_modules\n*.log\nshop_data.json\nverified_slips.json\nredemption_codes.json\nconfig.json\n*.pem\n*.env\n.DS_Store`
    };

    Object.entries(filesToCreate).forEach(([filename, contentFn]) => {
        const filepath = path.join(__dirname, filename);
        if (!fs.existsSync(filepath)) {
            try {
                fs.writeFileSync(filepath, contentFn().trim(), 'utf8');
                console.log(`Created initial file: ${filename}`);
                if (filename === 'package.json') console.log("--> Run 'npm install' <--");
            } catch (error) {
                console.error(`Error creating initial file ${filename}:`, error);
            }
        } else if (filename === '.gitignore' && !fs.readFileSync(filepath, 'utf8').includes('config.json')) {
            // Ensure config.json is in gitignore if file exists
            try {
                 fs.appendFileSync(filepath, '\nconfig.json\n');
                 console.log("Updated .gitignore to include config.json");
            } catch(error) {
                 console.error("Error updating .gitignore:", error);
            }
        }
    });

    // Create essential data files if missing after load attempts
    if (!fs.existsSync(DATA_FILE)) saveShopData();
    if (!fs.existsSync(VERIFIED_SLIPS_FILE)) saveVerifiedSlips();
    if (!fs.existsSync(REDEMPTION_CODES_FILE)) saveValidRedemptionCodes();
}

createInitialFiles(); 
