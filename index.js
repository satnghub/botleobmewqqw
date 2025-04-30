
const express = require('express');
const bodyParser = require('body-parser');
const request = require('request'); // Still used for Facebook API calls
const fs = require('fs');
const path = require('path');
const FormData = require('form-data'); // Needed for slip upload
const https = require('https');
const { Writable } = require('stream'); // Needed for downloading image to buffer
const axios = require('axios'); // For Xncly Slip Check API
const crypto = require('crypto'); // For code generation/hashing

// --- SSL Configuration ---
const privateKeyPath = '/etc/letsencrypt/live/scriptbotonline.vipv2boxth.xyz/privkey.pem';
const certificatePath = '/etc/letsencrypt/live/scriptbotonline.vipv2boxth.xyz/fullchain.pem';

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
    console.warn(`Make sure '${privateKeyPath}' and '${certificatePath}' exist and are readable.`);
}

// --- Core Configuration ---
const CONFIG = {
    // TrueMoney Wallet Angpao Settings
    WALLET_PHONE: '0825658423', // <<<<< ใส่เบอร์วอลเล็ท TrueMoney ของคุณ (สำหรับรับเงิน ไม่แสดงให้ผู้ใช้เห็น)
    WALLET_IMAGE: 'https://res09.bignox.com/appcenter/th/2020/05/TrueMoney.jpg',
    // Welcome GIF
    WELCOME_GIF: 'https://i.pinimg.com/originals/fe/f4/1f/fef41f9945b81122f30e216d02efd0a7.gif',
    // Bank Transfer Settings
    BANK_ACCOUNT_DETAILS: "ธนาคาร: กสิกรไทย\nเลขบัญชี: 206-3-13088-8\nชื่อบัญชี: พันวิลา บุยาหลง", // <<<<< ใส่ข้อมูลบัญชีธนาคารของคุณ
    BANK_IMAGE: 'https://i.pinimg.com/474x/c8/7a/a5/c87aa5a2adc0ac60659100f3e880aa41.jpg', // <<<<< รูปภาพโลโก้ธนาคาร
    // Code Redemption Settings
    CODE_REDEMPTION_IMAGE: 'https://cdn-icons-png.flaticon.com/512/1087/1087815.png', // <<<<< รูปภาพสำหรับตัวเลือกใช้โค้ด
    // Xncly Slip Check API Configuration
    XNCLY_SLIP_API: {
        CLIENT_ID_SECRET: '68ac5d834ae6dadfb9:59c3fe615570b9a0f643c112a302e45090a4a7470c725326', // <<<<< ใส่ ClientID:Secret ของคุณที่นี่!
        CHECK_URL: 'https://ccd.xncly.xyz/api/check-slip'
    }
};

// --- Facebook Messenger Configuration ---
const VERIFY_TOKEN = 'mysecretoken'; // <<<<< ใส่ Verify Token ของคุณที่ตั้งใน Facebook App
const PAGE_ACCESS_TOKEN = 'EAA69YPCejwEBO8znB2xyhE461yM3ZCvF6dqvOKmt19c4etKQK984sQmchA0yOOdc3KwDx9ClLTfgPOztIEjYnR6tRvxeSEMZA1fbee2mdZCyIrFu4W2ZAO2twrkeQSII97yRq6nDaFv31ah85FR7WRKSrcstMt6iDxQdZB8PSrU271vMRgAUvb1f5wkVpKorjYwZDZD'; // <<<<< ใส่ Page Access Token ของคุณ

// --- Data Storage ---
const DATA_FILE = path.join(__dirname, 'shop_data.json');
const VERIFIED_SLIPS_FILE = path.join(__dirname, 'verified_slips.json');
const REDEMPTION_CODES_FILE = path.join(__dirname, 'redemption_codes.json');

let shopData = {};
let verifiedSlips = [];
let validRedemptionCodes = [];

// --- Load or initialize shop data (with NEW structure validation) ---
try {
    if (fs.existsSync(DATA_FILE)) {
        shopData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        // --- Data structure validation ---
        if (!shopData) shopData = {};
        if (!Array.isArray(shopData.categories)) shopData.categories = [];
        shopData.categories = shopData.categories.map(category =>
            typeof category === 'string' ? { name: category, imageUrl: '', description: '' } : { name: category.name || 'Unnamed', imageUrl: category.imageUrl || '', description: category.description || '' }
        );

        // --- PRODUCT VALIDATION (CRITICAL FOR NEW STOCK SYSTEM) ---
        if (!Array.isArray(shopData.products)) shopData.products = [];
        shopData.products = shopData.products.map(product => {
            // Ensure downloadUrls exists and is an array
            if (product.downloadUrl && !product.downloadUrls) {
                // Convert old string format (handle potential multiline in old string)
                console.warn(`Converting old 'downloadUrl' string to 'downloadUrls' array for product ID ${product.id}`);
                product.downloadUrls = product.downloadUrl.split('\n').map(line => line.trim()).filter(line => line.length > 0);
                delete product.downloadUrl; // Remove the old field
            } else if (!Array.isArray(product.downloadUrls)) {
                 console.warn(`Product ID ${product.id} is missing or has invalid 'downloadUrls'. Initializing as empty array.`);
                 product.downloadUrls = [];
            }
            // Remove the old 'stock' property if it exists
            if (product.hasOwnProperty('stock')) {
                 console.warn(`Removing legacy 'stock' property from product ID ${product.id}`);
                 delete product.stock;
            }
            return product;
        });
        // --- End Product Validation ---

        if (typeof shopData.users !== 'object' || shopData.users === null) shopData.users = {};
        if (!Array.isArray(shopData.orders)) shopData.orders = [];
        // --- End General Validation ---
    } else {
        throw new Error("Shop data file not found, creating new one.");
    }
} catch (error) {
    console.warn(`Warning: ${error.message}. Initializing shop data with default structure.`);
    shopData = { products: [], categories: [], users: {}, orders: [] };
    saveShopData(); // Create the file with default structure
}

// --- Load or initialize verified slips data ---
try {
    if (fs.existsSync(VERIFIED_SLIPS_FILE)) {
        verifiedSlips = JSON.parse(fs.readFileSync(VERIFIED_SLIPS_FILE, 'utf8'));
        if (!Array.isArray(verifiedSlips)) {
            console.warn("Verified slips file is not an array, resetting.");
            verifiedSlips = [];
            saveVerifiedSlips();
        }
        console.log(`Loaded ${verifiedSlips.length} verified slip references.`);
    } else {
        console.log("Verified slips file not found, creating new one.");
        verifiedSlips = [];
        saveVerifiedSlips();
    }
} catch (error) {
    console.error(`Error loading verified slips file: ${error.message}. Initializing empty list.`);
    verifiedSlips = [];
    saveVerifiedSlips();
}

// --- Load or initialize valid redemption codes data ---
try {
    if (fs.existsSync(REDEMPTION_CODES_FILE)) {
        validRedemptionCodes = JSON.parse(fs.readFileSync(REDEMPTION_CODES_FILE, 'utf8'));
        if (!Array.isArray(validRedemptionCodes)) {
            console.warn("Redemption codes file is not an array, resetting.");
            validRedemptionCodes = [];
            saveValidRedemptionCodes();
        }
        console.log(`Loaded ${validRedemptionCodes.length} valid redemption codes.`);
    } else {
        console.log("Redemption codes file not found, creating new one.");
        validRedemptionCodes = [];
        saveValidRedemptionCodes();
    }
} catch (error) {
    console.error(`Error loading redemption codes file: ${error.message}. Initializing empty list.`);
    validRedemptionCodes = [];
    saveValidRedemptionCodes();
}


// --- Save Data Functions ---
function saveShopData() {
    try {
        // Ensure downloadUrls exists before saving
        if(shopData && shopData.products) {
            shopData.products.forEach(p => {
                if (!Array.isArray(p.downloadUrls)) {
                    console.warn(`Product ${p.id} missing downloadUrls array before save, initializing.`);
                    p.downloadUrls = [];
                }
                if (p.hasOwnProperty('stock')) {
                    delete p.stock; // Remove legacy field definitively
                }
                 if (p.hasOwnProperty('downloadUrl') && Array.isArray(p.downloadUrls)) {
                    delete p.downloadUrl; // Remove legacy field if new one exists
                }
            });
        }
        fs.writeFileSync(DATA_FILE, JSON.stringify(shopData, null, 2), 'utf8');
    } catch (error) {
        console.error("Error saving shop data to JSON file:", error);
    }
}

function saveVerifiedSlips() {
    try {
        fs.writeFileSync(VERIFIED_SLIPS_FILE, JSON.stringify(verifiedSlips, null, 2), 'utf8');
    } catch (error) {
        console.error("Error saving verified slips to JSON file:", error);
    }
}

function saveValidRedemptionCodes() {
    try {
        fs.writeFileSync(REDEMPTION_CODES_FILE, JSON.stringify(validRedemptionCodes, null, 2), 'utf8');
    } catch (error) {
        console.error("Error saving redemption codes to JSON file:", error);
    }
}

// --- Express App Setup ---
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files like admin CSS/JS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views')); // Set views directory for admin panel

// --- Facebook Messenger API Functions (Unchanged) ---
async function sendApiRequest(options) {
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
        qs: { access_token: PAGE_ACCESS_TOKEN },
        method: 'POST',
        json: {
            recipient: { id: sender },
            sender_action: action
        }
    };
    try {
        await sendApiRequest(options);
    } catch (error) {
        // console.warn(`Could not send typing indicator (${action}) to ${sender}:`, error.message || error);
    }
}

async function sendMessage(sender, text) {
    if (!sender || !text) return;
    try {
        await sendTypingIndicator(sender, 'typing_on');
        const options = {
            url: 'https://graph.facebook.com/v19.0/me/messages',
            qs: { access_token: PAGE_ACCESS_TOKEN },
            method: 'POST',
            json: { recipient: { id: sender }, message: { text: text } }
        };
        await sendApiRequest(options);
    } catch (error) { console.error(`Error sending text message to ${sender}:`, error.message || error); }
    finally { await sendTypingIndicator(sender, 'typing_off'); }
}

async function sendImageMessage(sender, imageUrl) {
    if (!sender || !imageUrl) return;
    try {
        await sendTypingIndicator(sender, 'typing_on');
        const options = {
            url: 'https://graph.facebook.com/v19.0/me/messages',
            qs: { access_token: PAGE_ACCESS_TOKEN },
            method: 'POST',
            json: { recipient: { id: sender }, message: { attachment: { type: "image", payload: { url: imageUrl, is_reusable: true } } } }
        };
        await sendApiRequest(options);
    } catch (error) { console.error(`Error sending image message to ${sender}:`, error.message || error); }
    finally { await sendTypingIndicator(sender, 'typing_off'); }
}

async function sendGenericTemplate(sender, elements) {
    if (!sender || !elements || !Array.isArray(elements) || elements.length === 0) return;
    try {
        await sendTypingIndicator(sender, 'typing_on');
        const options = {
            url: 'https://graph.facebook.com/v19.0/me/messages',
            qs: { access_token: PAGE_ACCESS_TOKEN },
            method: 'POST',
            json: { recipient: { id: sender }, message: { attachment: { type: "template", payload: { template_type: "generic", elements: elements.slice(0, 10) } } } }
        };
        await sendApiRequest(options);
    } catch (error) { console.error(`Error sending generic template to ${sender}:`, error.message || error); }
    finally { await sendTypingIndicator(sender, 'typing_off'); }
}

async function sendButtonTemplate(sender, text, buttons) {
    if (!sender || !text || !buttons || !Array.isArray(buttons) || buttons.length === 0) return;
    try {
        await sendTypingIndicator(sender, 'typing_on');
        const options = {
            url: 'https://graph.facebook.com/v19.0/me/messages',
            qs: { access_token: PAGE_ACCESS_TOKEN },
            method: 'POST',
            json: { recipient: { id: sender }, message: { attachment: { type: "template", payload: { template_type: "button", text: text, buttons: buttons.slice(0, 3) } } } }
        };
        await sendApiRequest(options);
    } catch (error) { console.error(`Error sending button template to ${sender}:`, error.message || error); }
    finally { await sendTypingIndicator(sender, 'typing_off'); }
}

async function sendQuickReplies(sender, text, quickReplies) {
    if (!sender || !text || !quickReplies || !Array.isArray(quickReplies) || quickReplies.length === 0) return;
    try {
        await sendTypingIndicator(sender, 'typing_on');
        const options = {
            url: 'https://graph.facebook.com/v19.0/me/messages',
            qs: { access_token: PAGE_ACCESS_TOKEN },
            method: 'POST',
            json: { recipient: { id: sender }, message: { text: text, quick_replies: quickReplies.slice(0, 13) } }
        };
        await sendApiRequest(options);
    } catch (error) { console.error(`Error sending quick replies to ${sender}:`, error.message || error); }
    finally { await sendTypingIndicator(sender, 'typing_off'); }
}

// --- Shop Logic Functions (MODIFIED for new stock system) ---
function getUserData(sender) {
    if (!shopData.users[sender]) {
        shopData.users[sender] = { cart: [], lastCategory: null, lastViewedProducts: [], currentPage: 0, checkoutState: null };
        saveShopData(); // Save immediately when a new user is created
    }
    if (!shopData.users[sender].cart) shopData.users[sender].cart = []; // Ensure cart is array
    if (!shopData.users[sender].checkoutState) shopData.users[sender].checkoutState = null;
    return shopData.users[sender];
}

async function showCategories(sender) {
    try {
        const categories = shopData.categories;
        if (categories.length === 0) {
            await sendMessage(sender, "ขออภัย ขณะนี้ยังไม่มีหมวดหมู่สินค้า");
            return;
        }
        await sendImageMessage(sender, CONFIG.WELCOME_GIF);
        await sendMessage(sender, "สวัสดีครับ! ยินดีต้อนรับสู่ร้านขายโค้ดและโปรแกรม\nเลือกหมวดหมู่ที่คุณสนใจได้เลยครับ 👇");
        const elements = categories.map(category => ({
            title: category.name,
            subtitle: category.description || "เลือกดูสินค้าในหมวดหมู่นี้",
            image_url: category.imageUrl || "https://via.placeholder.com/300x200?text=Category",
            buttons: [{ type: "postback", title: `ดูสินค้า ${category.name}`, payload: `CATEGORY_${category.name}` }]
        }));
        await sendGenericTemplate(sender, elements);
        await sendButtonTemplate(sender, "หรือเลือกดำเนินการอื่นๆ:", [
            { type: "postback", title: "🛒 ดูตะกร้า", payload: "CART_VIEW" },
            { type: "web_url", title: "💬 ติดต่อแอดมิน", url: "https://m.me/61555184860915" },
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
        // Sort by creation date (newest first), then slice for pagination
        const productsToShow = productsInCategory
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            .slice(skip, skip + pageSize);
        const totalProducts = productsInCategory.length;

        if (productsToShow.length === 0) {
            await sendMessage(sender, page === 0 ? `ขออภัย ไม่พบสินค้าในหมวดหมู่ "${categoryName}"` : "ไม่มีสินค้าเพิ่มเติมในหมวดหมู่นี้แล้ว");
            await sendButtonTemplate(sender, "กลับไปเลือกหมวดหมู่อื่นๆ", [{ type: "postback", title: "เลือกหมวดหมู่", payload: "SHOW_CATEGORIES" }]);
            return;
        }

        const user = getUserData(sender);
        user.lastCategory = categoryName;
        user.lastViewedProducts = productsToShow.map(p => p.id);
        user.currentPage = page;
        saveShopData();

        await sendMessage(sender, `🔎 สินค้าในหมวดหมู่ "${categoryName}" (หน้า ${page + 1}):`);

        const elements = productsToShow.map(product => {
             // NEW: Stock check based on downloadUrls array length
            const stockCount = product.downloadUrls?.length || 0;
            return {
                title: product.name + (stockCount <= 0 ? ' (หมด)' : ''),
                subtitle: `฿${product.price} | ${product.language || 'N/A'} | เหลือ ${stockCount} ชิ้น`,
                image_url: product.imageUrl || "https://via.placeholder.com/300x200?text=Product",
                buttons: [
                    { type: "postback", title: "ดูรายละเอียด", payload: `PRODUCT_VIEW_${product.id}` },
                    // Conditionally show Add to Cart button based on stockCount
                    ...(stockCount > 0 ? [{ type: "postback", title: "➕ หยิบใส่ตะกร้า (1 ชิ้น)", payload: `PRODUCT_ADD_TO_CART_${product.id}` }] : [])
                ]
            };
        });

        await sendGenericTemplate(sender, elements);

        // Pagination and navigation buttons
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

         // NEW: Stock check based on downloadUrls array length
         const stockCount = product.downloadUrls?.length || 0;

        await sendImageMessage(sender, product.imageUrl || "https://via.placeholder.com/300x200?text=Product");

        let detailText = `✨ ${product.name}\n`;
        detailText += `💰 ราคา: ฿${product.price}\n`;
        detailText += `📦 สถานะ: ${stockCount > 0 ? '✅ พร้อมส่ง' : '❌ สินค้าหมด'}\n`;
        if (stockCount > 0) {
            detailText += `📊 คงเหลือ: ${stockCount} ชิ้น\n`;
        }
        if (product.language) detailText += `⌨️ ภาษา: ${product.language}\n`;
        if (product.version) detailText += `🔄 เวอร์ชัน: ${product.version}\n`;
        detailText += `📄 รายละเอียด: ${product.description || 'ไม่มีรายละเอียดเพิ่มเติม'}`;

        await sendMessage(sender, detailText);

        const buttons = [];
        if (stockCount > 0) {
             // Modified title to reflect adding 1 item
            buttons.push({ type: "postback", title: "➕ หยิบใส่ตะกร้า (1 ชิ้น)", payload: `PRODUCT_ADD_TO_CART_${product.id}` });
        }
        buttons.push({ type: "postback", title: "🛒 ดูตะกร้า", payload: "CART_VIEW" });
        buttons.push({ type: "web_url", title: "💬 ติดต่อแอดมิน", url: "https://m.me/61555184860915" });

        await sendButtonTemplate(sender, "ดำเนินการต่อ:", buttons);

    } catch (error) {
        console.error(`Error in showProductDetail: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในการแสดงรายละเอียดสินค้า");
    }
}

async function addToCart(sender, productId) {
    try {
        const product = shopData.products.find(p => p.id === productId);
        if (!product) {
            return await sendMessage(sender, "ขออภัย ไม่พบสินค้านี้");
        }

         // NEW: Stock check based on downloadUrls array length
        const stockCount = product.downloadUrls?.length || 0;
        if (stockCount <= 0) {
            return await sendMessage(sender, `ขออภัย ${product.name} หมดสต็อกแล้ว`);
        }

        const user = getUserData(sender);

        // NEW: Simplified cart - each "add" adds one instance of the product.
        // No quantity tracking per cart item needed for this stock model.
        user.cart.push({
            // Store a unique ID for this specific cart entry if needed for removal,
            // or just use product ID and remove the first match. Let's use instance ID.
            cartItemId: `CART-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            productId: productId,
            name: product.name,
            price: product.price,
            imageUrl: product.imageUrl
            // No 'quantity' needed here
            // No 'downloadUrl' needed here, it's fetched during completion
        });

        saveShopData();
        await sendMessage(sender, `✅ เพิ่ม ${product.name} (1 ชิ้น) ลงตะกร้าเรียบร้อย`);

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
        const groupedItems = {}; // Group for display clarity

        // Calculate total and group items for display
        user.cart.forEach((item) => {
            totalAmount += item.price;
            if (!groupedItems[item.productId]) {
                groupedItems[item.productId] = { ...item, quantity: 0, cartItemIds: [] };
            }
            groupedItems[item.productId].quantity++;
            groupedItems[item.productId].cartItemIds.push(item.cartItemId); // Store IDs for removal
        });

        // Build summary string from grouped items
        Object.values(groupedItems).forEach((groupedItem, index) => {
             const itemTotal = groupedItem.price * groupedItem.quantity;
             cartSummary += `${index + 1}. ${groupedItem.name} (฿${groupedItem.price} x ${groupedItem.quantity} = ฿${itemTotal})\n`;

             // Add a remove button for *one* instance of this product type
             // We use the *first* cartItemId for this group as the target for removal
             cartQuickReplies.push({
                 content_type: "text",
                 title: `ลบ ${groupedItem.name.substring(0,15)}${groupedItem.name.length > 15 ? '...' : ''} (1 ชิ้น)`,
                 payload: `CART_REMOVE_INSTANCE_${groupedItem.cartItemIds[0]}` // Payload references the specific cart item ID
             });
        });

        cartSummary += `\n💰 ยอดรวมทั้งสิ้น: ฿${totalAmount.toFixed(2)}`;
        await sendMessage(sender, cartSummary);

        // Add other actions as quick replies
        if (cartQuickReplies.length < 12) cartQuickReplies.push({ content_type: "text", title: "ล้างตะกร้า", payload: "CART_CLEAR" });
        if (cartQuickReplies.length < 13) cartQuickReplies.push({ content_type: "text", title: "ชำระเงิน", payload: "CHECKOUT" });

        await sendQuickReplies(sender, "จัดการตะกร้าสินค้า:", cartQuickReplies.slice(0, 13)); // Ensure max 13

        // Main action buttons
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

// NEW: Function to remove a specific instance of an item from the cart
async function removeFromCartInstance(sender, cartItemIdToRemove) {
    try {
        const user = getUserData(sender);
        const itemIndex = user.cart.findIndex(item => item.cartItemId === cartItemIdToRemove);

        if (itemIndex === -1) {
            return await sendMessage(sender, "ไม่พบรายการสินค้านี้ในตะกร้า (อาจถูกลบไปแล้ว)");
        }

        const removedItemName = user.cart[itemIndex].name;
        user.cart.splice(itemIndex, 1); // Remove the specific item instance
        saveShopData();
        await sendMessage(sender, `🗑️ ลบ ${removedItemName} (1 ชิ้น) ออกจากตะกร้าแล้ว`);
        await viewCart(sender); // Show updated cart

    } catch (error) {
        console.error(`Error in removeFromCartInstance: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในการลบสินค้าออกจากตะกร้า");
    }
}


async function clearCart(sender) {
    try {
        const user = getUserData(sender);
        user.cart = []; // Clear the cart array
        saveShopData();
        await sendMessage(sender, "🗑️ ล้างตะกร้าสินค้าเรียบร้อยแล้ว");
        await sendButtonTemplate(sender, "เริ่มต้นเลือกซื้อสินค้าใหม่ได้เลย", [{ type: "postback", title: "เลือกหมวดหมู่", payload: "SHOW_CATEGORIES" }]);
    } catch (error) {
        console.error(`Error in clearCart: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในการล้างตะกร้าสินค้า");
    }
}
// --- End Shop Logic Functions ---

// --- Checkout and Payment Processing (MODIFIED for new stock logic) ---
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
        const itemsNeeded = {}; // Track count needed per product ID

        // Calculate total and check stock requirements
        user.cart.forEach(item => {
            totalAmount += item.price;
            itemsNeeded[item.productId] = (itemsNeeded[item.productId] || 0) + 1;
        });

        // Verify stock availability AGAIN based on counts needed
        for (const productId in itemsNeeded) {
            const product = shopData.products.find(p => p.id === productId);
            const neededCount = itemsNeeded[productId];
            const availableCount = product?.downloadUrls?.length || 0;

            if (!product || availableCount < neededCount) {
                hasInsufficientStock = true;
                stockIssues.push(`${product ? product.name : `ID ${productId}`} (ต้องการ ${neededCount}, มี ${availableCount})`);
            }
        }

        if (hasInsufficientStock) {
            await sendMessage(sender, `❌ ขออภัย มีสินค้าบางรายการในตะกร้าไม่เพียงพอ:\n- ${stockIssues.join('\n- ')}\nกรุณาปรับปรุงตะกร้าของคุณก่อนชำระเงิน`);
            await viewCart(sender); // Show cart again so user can fix it
            return;
        }

        // Set checkout state
        user.checkoutState = { step: 'select_method', totalAmount: totalAmount };
        saveShopData();

        await sendMessage(sender, `ยอดรวมที่ต้องชำระ: ฿${totalAmount.toFixed(2)}`);
        await sendMessage(sender, "กรุณาเลือกช่องทางการชำระเงิน หรือใช้โค้ดรับของ:");

        // Payment/Redemption options (same as before)
        const paymentElements = [
            { title: "TrueMoney Wallet (ซองอั่งเปา)", subtitle: `สร้างและส่งซองอั่งเปามูลค่า ฿${totalAmount.toFixed(2)}\nระบบจะรับซองอัตโนมัติ`, image_url: CONFIG.WALLET_IMAGE, buttons: [{ type: "postback", title: "เลือกชำระผ่าน Wallet", payload: "PAYMENT_ANGPAO" }] },
            { title: "โอนเงินผ่านธนาคาร", subtitle: `โอนเงิน ฿${totalAmount.toFixed(2)}\n${CONFIG.BANK_ACCOUNT_DETAILS.split('\n')[0]}`, image_url: CONFIG.BANK_IMAGE, buttons: [{ type: "postback", title: "เลือกชำระผ่านธนาคาร", payload: "PAYMENT_BANK" }] },
            { title: "ใช้โค้ดรับของ", subtitle: "กรอกโค้ด 32 หลักที่คุณมี เพื่อรับสินค้า", image_url: CONFIG.CODE_REDEMPTION_IMAGE, buttons: [{ type: "postback", title: "เลือกใช้โค้ด", payload: "PAYMENT_REDEEM_CODE" }] }
        ];

        await sendGenericTemplate(sender, paymentElements);
        await sendButtonTemplate(sender, "หากต้องการยกเลิก", [{ type: "postback", title: "❌ ยกเลิก", payload: "CANCEL_PAYMENT" }]);

    } catch (error) {
        console.error(`Error in checkout: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในขั้นตอนการชำระเงิน กรุณาลองใหม่");
        const user = getUserData(sender);
        if (user.checkoutState) {
            delete user.checkoutState;
            saveShopData();
        }
    }
}

// processPaymentMethod remains largely the same, as it directs the user
async function processPaymentMethod(sender, method) {
    try {
        const user = getUserData(sender);
        if (!user.checkoutState || user.checkoutState.step !== 'select_method') {
            await sendMessage(sender, "สถานะไม่ถูกต้อง กรุณาเริ่มขั้นตอนการชำระเงินใหม่อีกครั้ง");
            await checkout(sender);
            return;
        }
        const totalAmount = user.checkoutState.totalAmount;
        const cancelButton = { type: "postback", title: "❌ ยกเลิก", payload: "CANCEL_PAYMENT" };

        if (method === 'angpao') {
            user.checkoutState.step = 'awaiting_angpao_link';
            user.checkoutState.paymentMethod = 'angpao';
            await sendMessage(sender, `📱 กรุณาสร้างซองอั่งเปา TrueMoney Wallet มูลค่า ฿${totalAmount.toFixed(2)}`);
            await sendButtonTemplate(sender, "จากนั้นส่ง 'ลิงก์ซองอั่งเปา' ที่สร้างเสร็จมาที่นี่ ระบบจะตรวจสอบและรับซองเข้าเบอร์ร้านค้าโดยอัตโนมัติ\n\nตัวอย่าง:\nhttps://gift.truemoney.com/campaign/?v=...", [cancelButton]);
        } else if (method === 'bank') {
            user.checkoutState.step = 'awaiting_bank_slip';
            user.checkoutState.paymentMethod = 'bank';
            await sendMessage(sender, `🏦 กรุณาโอนเงินจำนวน ฿${totalAmount.toFixed(2)} มาที่บัญชี:`);
            await sendMessage(sender, CONFIG.BANK_ACCOUNT_DETAILS);
            await sendButtonTemplate(sender, "เมื่อโอนเงินเรียบร้อยแล้ว กรุณา 'ส่งรูปสลิป' การโอนเงินมาที่นี่เพื่อตรวจสอบ", [cancelButton]);
        } else if (method === 'redeem_code') {
            user.checkoutState.step = 'awaiting_redeem_code';
            user.checkoutState.paymentMethod = 'redeem_code';
            await sendMessage(sender, `🔑 กรุณาส่ง 'โค้ดรับของ' (ความยาว 32 ตัวอักษร) ที่คุณได้รับมาที่นี่`);
            await sendButtonTemplate(sender, "พิมพ์โค้ดของคุณแล้วส่งได้เลย", [cancelButton]);
        } else {
            await sendMessage(sender, "❌ วิธีการชำระเงินไม่ถูกต้อง");
             user.checkoutState.step = 'select_method';
        }
        saveShopData(); // Save state change
    } catch (error) {
        console.error(`Error in processPaymentMethod (${method}): ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาด โปรดลองเลือกวิธีชำระเงินอีกครั้ง");
        const user = getUserData(sender);
        if (user.checkoutState) { user.checkoutState.step = 'select_method'; saveShopData(); }
    }
}

// handleCheckoutTextInput remains largely the same for Angpao/Redeem Code logic
async function handleCheckoutTextInput(sender, text) {
    try {
        const user = getUserData(sender);
        if (!user.checkoutState) return false;

        // Handle Angpao Link
        if (user.checkoutState.step === 'awaiting_angpao_link') {
            const LINK_REGEX = /https:\/\/gift\.truemoney\.com\/campaign\/\?v=([a-zA-Z0-9]{35})/;
            const match = text.trim().match(LINK_REGEX);
            if (!match) {
                await sendMessage(sender, "⚠️ ลิงก์ซองอั่งเปาไม่ถูกต้อง กรุณาตรวจสอบและส่งลิงก์ที่ถูกต้อง:\n(ตัวอย่าง: https://gift.truemoney.com/campaign/?v=...)");
                return true;
            }
            const angpaoLink = match[0];
            const recipientPhone = CONFIG.WALLET_PHONE;
            const expectedAmount = user.checkoutState.totalAmount;
            await sendMessage(sender, "⏳ กำลังตรวจสอบลิงก์ซองอั่งเปา...");
            const verificationResult = await verifyAngpaoLink(recipientPhone, angpaoLink, expectedAmount);
            if (verificationResult.success) {
                await sendMessage(sender, "✅ การชำระเงินผ่านซองอั่งเปาสำเร็จ!");
                await completeOrder(sender, 'angpao', angpaoLink); // COMPLETE ORDER
            } else {
                await sendMessage(sender, `❌ การตรวจสอบล้มเหลว: ${verificationResult.message}`);
                await sendMessage(sender, "กรุณาตรวจสอบลิงก์ จำนวนเงิน หรือสร้างซองใหม่แล้วส่งลิงก์อีกครั้ง");
            }
            return true;
        }

        // Handle Redemption Code
        if (user.checkoutState.step === 'awaiting_redeem_code') {
            const code = text.trim();
            const CODE_LENGTH = 32;
            if (code.length !== CODE_LENGTH) {
                await sendMessage(sender, `⚠️ โค้ดไม่ถูกต้อง กรุณาส่งโค้ดความยาว ${CODE_LENGTH} ตัวอักษร`);
                return true;
            }
            await sendMessage(sender, "⏳ กำลังตรวจสอบโค้ด...");
            const verificationResult = await verifyRedemptionCode(code);
            if (verificationResult.success) {
                await sendMessage(sender, "✅ โค้ดถูกต้อง!");
                // Remove code *before* completing order
                validRedemptionCodes = validRedemptionCodes.filter(c => c !== code);
                saveValidRedemptionCodes();
                console.log(`Redemption code ${code} used by ${sender} and removed.`);
                await completeOrder(sender, 'redeem_code', code); // COMPLETE ORDER
            } else {
                await sendMessage(sender, `❌ การตรวจสอบโค้ดล้มเหลว: ${verificationResult.message}`);
                await sendMessage(sender, "กรุณาตรวจสอบโค้ดอีกครั้ง หรือติดต่อแอดมินหากมั่นใจว่าโค้ดถูกต้อง");
            }
             return true;
        }
        return false; // Not handled by this function
    } catch (error) {
        console.error(`Error in handleCheckoutTextInput: ${error.message}`);
        await sendMessage(sender, "❌ ขออภัย เกิดข้อผิดพลาดในการประมวลผลข้อมูลชำระเงิน กรุณาลองใหม่");
        await sendButtonTemplate(sender, "พบข้อผิดพลาด", [{ type: "postback", title: "❌ ยกเลิก", payload: "CANCEL_PAYMENT" }]);
        return true;
    }
}

// handleCheckoutImageInput remains largely the same for Bank Slip logic
async function handleCheckoutImageInput(sender, imageUrl) {
    try {
        const user = getUserData(sender);
        if (!user.checkoutState || user.checkoutState.step !== 'awaiting_bank_slip') return false;

        const expectedAmount = user.checkoutState.totalAmount;
        await sendMessage(sender, "⏳ ได้รับสลิปแล้ว กำลังตรวจสอบกับระบบ...");
        const verificationResult = await verifyBankSlipXncly(sender, imageUrl, expectedAmount);

        if (verificationResult.success) {
            await sendMessage(sender, "✅ การชำระเงินผ่านการโอนเงินสำเร็จ!");
            const confirmationData = verificationResult.confirmationData || imageUrl;
            await completeOrder(sender, 'bank', confirmationData); // COMPLETE ORDER
        } else {
            await sendMessage(sender, `❌ การตรวจสอบสลิปล้มเหลว: ${verificationResult.message}`);
            await sendMessage(sender, "กรุณาตรวจสอบสลิป หรือลองส่งรูปใหม่อีกครั้ง");
        }
        return true;
    } catch (error) {
        console.error(`Error in handleCheckoutImageInput: ${error.message}`);
        await sendMessage(sender, "❌ ขออภัย เกิดข้อผิดพลาดในการประมวลผลสลิป กรุณาลองใหม่");
        await sendButtonTemplate(sender, "พบข้อผิดพลาด", [{ type: "postback", title: "❌ ยกเลิก", payload: "CANCEL_PAYMENT" }]);
        return true;
    }
}
// --- End Checkout Handling ---

// --- Payment Verification Functions (Unchanged) ---
// verifyAngpaoLink, downloadImageToBuffer, verifyBankSlipXncly, verifyRedemptionCode
// remain the same as in the previous version. They don't depend on the internal stock count method.
// (Copying them here for completeness)
async function verifyAngpaoLink(phoneToRedeem, voucherLink, expectedAmount) {
    const LINK_REGEX = /https:\/\/gift\.truemoney\.com\/campaign\/\?v=([a-zA-Z0-9]{35})/;
    const voucherHash = voucherLink.match(LINK_REGEX)?.[1];
    if (!voucherHash) return { success: false, message: 'รูปแบบลิงก์ซองอั่งเปาไม่ถูกต้อง' };
    if (!phoneToRedeem) return { success: false, message: 'ไม่ได้กำหนดเบอร์โทรศัพท์ผู้รับ (Wallet Phone) ในระบบ' };
    console.log(`Attempting to Redeem Angpao: Hash=${voucherHash}, Redeem to Phone=${phoneToRedeem}, Expected=฿${expectedAmount}`);
    await sendTypingIndicator(phoneToRedeem, 'typing_on');
    try {
        const response = await fetch(`https://gift.truemoney.com/campaign/vouchers/${voucherHash}/redeem`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ mobile: phoneToRedeem, voucher_hash: voucherHash }),
        });
        const data = await response.json();
        console.log("Angpao API Response:", JSON.stringify(data, null, 2));
        if (data.status?.code === 'SUCCESS') {
            const redeemedAmount = parseFloat(data.data?.my_ticket?.amount_baht);
            console.log(`Angpao Redeemed Amount: ฿${redeemedAmount}`);
            if (isNaN(redeemedAmount)) return { success: false, message: 'ไม่สามารถอ่านจำนวนเงินจากซองได้หลังจากรับสำเร็จ' };
            if (Math.abs(redeemedAmount - expectedAmount) < 0.01) return { success: true, message: 'การยืนยันสำเร็จ' };
            else {
                console.warn(`Angpao amount mismatch: Redeemed ฿${redeemedAmount}, Expected ฿${expectedAmount}`);
                return { success: false, message: `จำนวนเงินในซองที่รับได้ (฿${redeemedAmount.toFixed(2)}) ไม่ตรงกับยอดที่ต้องชำระ (฿${expectedAmount.toFixed(2)}) โปรดติดต่อแอดมิน` };
            }
        } else {
            let errorMessage = data.status?.message || 'ไม่สามารถรับซองได้ (ข้อผิดพลาดไม่ทราบสาเหตุ)';
            if (errorMessage.includes("VOUCHER_OUT_OF_STOCK")) errorMessage = "ซองอั่งเปานี้ถูกใช้ไปหมดแล้ว";
            else if (errorMessage.includes("VOUCHER_NOT_FOUND")) errorMessage = "ไม่พบซองอั่งเปานี้ หรือลิงก์ไม่ถูกต้อง";
            else if (errorMessage.includes("TARGET_USER_HAS_ALREADY_REDEEMED")) errorMessage = "เบอร์ร้านค้ารับซองนี้ไปแล้ว";
            else if (errorMessage.includes("INTERNAL_ERROR") || errorMessage.includes("PROCESS_VOUCHER_FAILED")) errorMessage = "ระบบ TrueMoney ขัดข้องชั่วคราว โปรดลองอีกครั้ง";
            else if (errorMessage.includes("VOUCHER_EXPIRED")) errorMessage = "ซองอั่งเปานี้หมดอายุแล้ว";
            console.log("Angpao Redemption Failed:", errorMessage);
            return { success: false, message: `ไม่สามารถรับซองได้: ${errorMessage}` };
        }
    } catch (error) {
        console.error('Angpao Verification/Redemption Network Error:', error);
        return { success: false, message: `เกิดข้อผิดพลาดในการเชื่อมต่อกับ TrueMoney: ${error.message || 'Network Error'}` };
    } finally { await sendTypingIndicator(phoneToRedeem, 'typing_off'); }
}

async function downloadImageToBuffer(imageUrl) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const protocol = imageUrl.startsWith('https') ? https : require('http');
        protocol.get(imageUrl, (response) => {
            if (response.statusCode !== 200) return reject(new Error(`Failed to download image, status code: ${response.statusCode}`));
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', (err) => reject(new Error(`Error downloading image: ${err.message}`)));
    });
}

async function verifyBankSlipXncly(sender, imageUrl, expectedAmount) {
    const { CLIENT_ID_SECRET, CHECK_URL } = CONFIG.XNCLY_SLIP_API;
    if (!CLIENT_ID_SECRET || !CLIENT_ID_SECRET.includes(':')) return { success: false, message: 'ไม่ได้ตั้งค่า Xncly API ClientID:Secret หรือรูปแบบไม่ถูกต้อง' };
    if (!CHECK_URL) return { success: false, message: 'ไม่ได้ตั้งค่า Xncly API CHECK_URL' };
    console.log(`Verifying Bank Slip (Xncly): URL=${imageUrl}, Expected=฿${expectedAmount}`);
    await sendTypingIndicator(sender, 'typing_on');
    try {
        await sendMessage(sender, "กำลังดาวน์โหลดรูปสลิป...");
        const imageBuffer = await downloadImageToBuffer(imageUrl);
        console.log(`Downloaded image buffer, size: ${imageBuffer.length} bytes`);
        await sendMessage(sender, "ดาวน์โหลดสำเร็จ กำลังส่งไปตรวจสอบ...");
        const formData = new FormData();
        formData.append('ClientID-Secret', CLIENT_ID_SECRET);
        formData.append('image', imageBuffer, { filename: 'slip.jpg', contentType: 'image/jpeg' });
        console.log("Sending slip to Xncly API...");
        const response = await axios.post(CHECK_URL, formData, { headers: formData.getHeaders(), timeout: 45000 });
        const data = response.data;
        console.log("Xncly Slip API Response:", JSON.stringify(data, null, 2));
        if (data && data.status === true && data.result && data.result.amount !== undefined) {
            const slipAmount = parseFloat(data.result.amount);
            const slipReferenceId = data.result.reference_id;
            if (slipReferenceId) {
                console.log(`Xncly Slip Ref ID: ${slipReferenceId}`);
                if (verifiedSlips.includes(slipReferenceId)) {
                    console.warn(`Duplicate Slip Detected: Reference ID ${slipReferenceId} has already been used.`);
                    return { success: false, message: 'สลิปนี้ถูกใช้งานไปแล้ว (Ref ID ซ้ำ)' };
                }
            } else console.warn("Xncly API did not return a reference_id for this slip. Duplicate check skipped.");
            if (isNaN(slipAmount)) {
                console.error("Xncly API returned non-numeric amount:", data.result.amount);
                return { success: false, message: 'ไม่สามารถอ่านจำนวนเงินจากสลิปที่ตรวจสอบได้' };
            }
            console.log(`Xncly verification successful, Amount: ฿${slipAmount}`);
            if (Math.abs(slipAmount - expectedAmount) < 0.01) {
                if (slipReferenceId) {
                    verifiedSlips.push(slipReferenceId);
                    saveVerifiedSlips();
                    console.log(`Stored verified slip Ref ID: ${slipReferenceId}`);
                }
                 return { success: true, message: 'การยืนยันสำเร็จ', confirmationData: slipReferenceId || `Verified ${slipAmount.toFixed(2)} THB` };
            } else return { success: false, message: `จำนวนเงินในสลิป (฿${slipAmount.toFixed(2)}) ไม่ตรงกับยอดที่ต้องชำระ (฿${expectedAmount.toFixed(2)})` };
        } else {
            let errorMessage = data?.message || 'ไม่สามารถตรวจสอบสลิปได้ (ข้อผิดพลาดจาก API)';
            console.error("Xncly Slip Check Failed:", errorMessage, data);
            if (errorMessage.includes("ClientID-Secret ไม่ถูกต้อง")) errorMessage = "ข้อมูล API ไม่ถูกต้อง กรุณาติดต่อแอดมิน";
            else if (errorMessage.includes("Package expired") || errorMessage.includes("Invalid quota")) errorMessage = "โควต้าตรวจสอบสลิปหมด กรุณาติดต่อแอดมิน";
            else if (errorMessage.includes("Invalid image") || errorMessage.includes("Unable read QR")) errorMessage = "รูปสลิปไม่ถูกต้อง อ่านไม่ได้ หรือไม่ใช่สลิปธนาคารที่รองรับ";
            else if (errorMessage.includes("Not support bank slip")) errorMessage = `สลิปจากธนาคารนี้ยังไม่รองรับโดยระบบตรวจสอบ`;
            else if (errorMessage.includes("Duplicate slip") || errorMessage.includes("Duplicate slip in system")) errorMessage = 'ตรวจพบสลิปซ้ำในระบบของผู้ให้บริการ API นี้แล้ว';
            return { success: false, message: `การตรวจสอบล้มเหลว: ${errorMessage}` };
        }
    } catch (error) {
        console.error('Xncly Bank Slip Verification Error:', error);
        let friendlyMessage = "เกิดข้อผิดพลาดในการตรวจสอบสลิป";
        if (axios.isAxiosError(error)) {
            if (error.response) friendlyMessage = `เกิดข้อผิดพลาดจากระบบตรวจสอบสลิป: ${error.response.data?.message || error.response.statusText}`;
            else if (error.request) friendlyMessage = error.code === 'ECONNABORTED' ? "ระบบตรวจสอบสลิปใช้เวลานานเกินไป (Timeout) กรุณาลองอีกครั้ง" : "ไม่สามารถเชื่อมต่อกับระบบตรวจสอบสลิปได้";
            else friendlyMessage = `เกิดข้อผิดพลาดในการตั้งค่าการร้องขอ: ${error.message}`;
        } else friendlyMessage += `: ${error.message}`;
        return { success: false, message: friendlyMessage };
    } finally { await sendTypingIndicator(sender, 'typing_off'); }
}

async function verifyRedemptionCode(code) {
    if (!code) return { success: false, message: 'ไม่ได้ระบุโค้ด' };
    console.log(`Verifying Redemption Code: ${code}`);
    const codeIndex = validRedemptionCodes.findIndex(validCode => validCode === code);
    if (codeIndex !== -1) {
        console.log(`Redemption code ${code} is valid.`);
        return { success: true, message: 'โค้ดถูกต้อง' };
    } else {
        console.log(`Redemption code ${code} is invalid or already used.`);
        return { success: false, message: 'โค้ดไม่ถูกต้อง หรือถูกใช้ไปแล้ว' };
    }
}
// --- End Payment Verification ---

// --- Order Completion and Helper Functions (REWRITTEN for new stock system) ---

// Removed old updateProductStock function - stock is updated directly in completeOrder

// Sends the specific delivered data for an item
async function sendDeliveredItemData(sender, orderItem) {
    // orderItem now contains { productId, name, price, deliveredData }
    await sendMessage(sender, `🎁 สินค้า: ${orderItem.name}`);
    if (orderItem.deliveredData) {
        // Check if it looks like a URL
        if (orderItem.deliveredData.startsWith('http://') || orderItem.deliveredData.startsWith('https://')) {
             await sendMessage(sender, `🔗 ลิงก์/ข้อมูล: ${orderItem.deliveredData}`);
             // Optionally attempt to send as file if needed in future
        } else {
             // Treat as text/code
             await sendMessage(sender, `🔑 โค้ด/ข้อมูล:\n\`\`\`\n${orderItem.deliveredData}\n\`\`\``); // Use markdown for code blocks
        }
    } else {
        // This case should ideally not happen if logic is correct
        await sendMessage(sender, "⚠️ ไม่พบข้อมูลสำหรับจัดส่งสินค้านี้ กรุณาติดต่อแอดมินเพื่อรับสินค้า (Error Code: DNF)");
        console.error(`Error: Delivered data missing for order item ${orderItem.productId} for user ${sender}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500)); // Short delay
}


async function completeOrder(sender, paymentMethod, paymentConfirmation) {
    try {
        const user = getUserData(sender);
        // Critical checks
        if (!user.checkoutState || !user.cart || user.cart.length === 0) {
            console.error(`Error in completeOrder: User ${sender} has missing checkout state or empty cart.`);
            await sendMessage(sender, "เกิดข้อผิดพลาดร้ายแรง: ไม่พบข้อมูลตะกร้าสินค้า/การชำระเงินของคุณ โปรดติดต่อแอดมิน (Error Code: CMPL_STATE)");
            if(user.checkoutState) { delete user.checkoutState; saveShopData(); }
            return;
        }

        const orderId = `ORD-${Date.now()}-${sender.slice(-4)}`;
        const processedOrderItems = []; // Will store items with their *delivered* data
        let stockUpdateError = false;
        let stockErrorDetails = "";

        // --- CRITICAL SECTION: Process items and update stock atomically ---
        // 1. Iterate through each item the user intends to buy (items in cart)
        for (const cartItem of user.cart) {
            const productIndex = shopData.products.findIndex(p => p.id === cartItem.productId);
            if (productIndex === -1) {
                stockUpdateError = true;
                stockErrorDetails = `ไม่พบสินค้า ID ${cartItem.productId} ในระบบ`;
                console.error(`Error completing order ${orderId}: Product ${cartItem.productId} not found.`);
                break; // Stop processing this order
            }

            const product = shopData.products[productIndex];

            // 2. Check stock AGAIN (length of downloadUrls) just before taking one
            if (!product.downloadUrls || product.downloadUrls.length === 0) {
                 stockUpdateError = true;
                 stockErrorDetails = `สินค้า ${product.name} หมดสต็อกก่อนการตัดสต็อก`;
                 console.error(`Error completing order ${orderId}: Product ${product.id} (${product.name}) ran out of stock before fulfillment.`);
                 break; // Stop processing this order
            }

            // 3. Take the first available item data (code/link)
            const deliveredData = product.downloadUrls.shift(); // Removes the first element AND returns it

            // 4. Add the processed item (with the specific data) to our order list
            processedOrderItems.push({
                productId: cartItem.productId,
                name: cartItem.name,
                price: cartItem.price,
                deliveredData: deliveredData // Store the *specific* data given
            });

             // Mark product as updated (for saving later)
             product.updatedAt = new Date().toISOString();
             console.log(`Order ${orderId}: Dispensed item for ${product.name}. Remaining: ${product.downloadUrls.length}`);
        }
        // --- END CRITICAL SECTION ---

        // 5. Handle Stock Error during processing
        if (stockUpdateError) {
            // IMPORTANT: We didn't save shopData yet, so the stock wasn't *actually* reduced.
            // We need to inform the user and maybe revert their checkout state?
            console.error(`Order ${orderId} failed due to stock issue: ${stockErrorDetails}`);
            await sendMessage(sender, `❌ ขออภัย เกิดข้อผิดพลาดร้ายแรงระหว่างการตัดสต็อก: ${stockErrorDetails}. การสั่งซื้อยังไม่สมบูรณ์ กรุณาติดต่อแอดมิน (Error Code: CMPL_STOCK)`);
            // Do NOT proceed with creating the order or clearing cart/state
            // Let the user retry checkout or contact admin.
            // Maybe reset checkout state?
            delete user.checkoutState;
            saveShopData(); // Save only the reset state
            return;
        }

        // 6. If all stock processed successfully, create the final order object
        const newOrder = {
            id: orderId,
            userId: sender,
            items: processedOrderItems, // Use the items with deliveredData
            totalAmount: user.checkoutState.totalAmount || 0,
            paymentMethod: paymentMethod,
            paymentStatus: 'paid',
            paymentConfirmation: paymentConfirmation,
            status: 'completed',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        // 7. Add order to the list
        shopData.orders.push(newOrder);

        // 8. Clear user's cart and checkout state (now that stock is secured)
        user.cart = [];
        delete user.checkoutState;

        // 9. Save ALL changes (product stock updates AND new order AND user state)
        saveShopData();

        console.log(`Order ${orderId} completed successfully for user ${sender}. Payment: ${paymentMethod}. Items: ${processedOrderItems.length}`);

        // 10. Notify user and send items
        await sendMessage(sender, `🎉 ขอบคุณสำหรับการสั่งซื้อ!\nรหัสคำสั่งซื้อของคุณ: ${orderId}`);
        await sendMessage(sender, "✅ การชำระเงิน/ยืนยันโค้ดเรียบร้อย");
        await sendMessage(sender, "🚚 กำลังจัดส่งสินค้าดิจิทัลของคุณ...");

        await sendTypingIndicator(sender);
        for (const item of newOrder.items) {
            await sendDeliveredItemData(sender, item); // Send the specific data
        }
        await sendTypingIndicator(sender, 'typing_off');

        await sendMessage(sender, "✨ การจัดส่งเสร็จสมบูรณ์! หากมีปัญหา หรือไม่ได้รับสินค้า กรุณาติดต่อแอดมินพร้อมแจ้งรหัสคำสั่งซื้อ");
        await sendButtonTemplate(sender, "เลือกดูสินค้าอื่นๆ หรือติดต่อสอบถาม", [
            { type: "postback", title: "เลือกหมวดหมู่อื่น", payload: "SHOW_CATEGORIES" },
            { type: "web_url", title: "💬 ติดต่อแอดมิน", url: "https://m.me/61555184860915" }
        ]);

    } catch (error) {
        console.error(`Critical Error in completeOrder for user ${sender}: ${error.message}`, error.stack);
        await sendMessage(sender, "❌ ขออภัย เกิดข้อผิดพลาดร้ายแรงที่ไม่คาดคิดในขั้นตอนสุดท้ายของการสั่งซื้อ กรุณาติดต่อแอดมินพร้อมแจ้งรหัสผู้ใช้ (PSID) ของคุณเพื่อตรวจสอบ (Error Code: CMPL_FATAL)");
         // Attempt to clean up user state, data might be inconsistent if error was mid-process
         const user = getUserData(sender);
         if (user.checkoutState) { delete user.checkoutState; }
         // Don't clear cart here, as we don't know if stock was deducted fully
         saveShopData(); // Save at least the state cleanup
    }
}

// cancelPayment remains the same
async function cancelPayment(sender) {
    try {
        const user = getUserData(sender);
        if (user.checkoutState) {
            const prevState = user.checkoutState.step;
            delete user.checkoutState; // Remove the checkout state
            saveShopData();
            await sendMessage(sender, "✅ ยกเลิกขั้นตอนการชำระเงิน/ใช้โค้ดเรียบร้อยแล้ว");
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


// --- Search, Featured Products, Help Functions (MODIFIED stock display) ---
async function searchProducts(sender, searchTerm) {
    try {
        if (!searchTerm || searchTerm.trim().length < 2) {
            await sendMessage(sender, "กรุณาระบุคำค้นหาอย่างน้อย 2 ตัวอักษร");
            return;
        }
        const searchTermLower = searchTerm.toLowerCase().trim();
        const results = shopData.products.filter(product =>
            (product.name.toLowerCase().includes(searchTermLower) ||
             (product.description && product.description.toLowerCase().includes(searchTermLower)) ||
             (product.language && product.language.toLowerCase().includes(searchTermLower)) ||
             (product.category && product.category.toLowerCase().includes(searchTermLower)) ||
              product.id === searchTerm)
        );

        if (results.length === 0) {
            await sendMessage(sender, `⚠️ ไม่พบสินค้าที่ตรงกับคำค้นหา "${searchTerm}"`);
            await sendButtonTemplate(sender,"ลองค้นหาใหม่ หรือดูหมวดหมู่ทั้งหมด",[{ type: "postback", title: "ดูหมวดหมู่", payload: "SHOW_CATEGORIES" }]);
            return;
        }

        await sendMessage(sender, `🔎 ผลการค้นหาสำหรับ "${searchTerm}" (${results.length} รายการ):`);
        const elements = results.slice(0, 10).map(product => {
             const stockCount = product.downloadUrls?.length || 0; // NEW stock check
             return {
                title: product.name + (stockCount <= 0 ? ' (หมด)' : ''),
                subtitle: `฿${product.price} | ${product.category} | เหลือ ${stockCount}`, // Display stock count
                image_url: product.imageUrl || "https://via.placeholder.com/300x200?text=Result",
                buttons: [
                    { type: "postback", title: "ดูรายละเอียด", payload: `PRODUCT_VIEW_${product.id}` },
                    ...(stockCount > 0 ? [{ type: "postback", title: "➕ หยิบใส่ตะกร้า (1 ชิ้น)", payload: `PRODUCT_ADD_TO_CART_${product.id}` }] : [])
                ]
             };
        });
        await sendGenericTemplate(sender, elements);

        await sendButtonTemplate(sender, "ดำเนินการต่อ:", [
            { type: "postback", title: "ดูหมวดหมู่ทั้งหมด", payload: "SHOW_CATEGORIES" },
            { type: "postback", title: "🛒 ดูตะกร้า", payload: "CART_VIEW" }
        ]);
    } catch (error) {
        console.error(`Error in searchProducts: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในการค้นหาสินค้า");
    }
}

async function showFeaturedProducts(sender) {
    try {
        const featuredProducts = shopData.products
            .filter(p => p.downloadUrls?.length > 0) // Only show in-stock (NEW check)
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) // Sort by newest first
            .slice(0, 5); // Take top 5

        if (featuredProducts.length === 0) {
            await sendMessage(sender, "ตอนนี้ยังไม่มีสินค้าแนะนำพิเศษ ลองดูหมวดหมู่ทั้งหมดก่อนนะครับ");
            await showCategories(sender);
            return;
        }

        await sendMessage(sender, "🌟 สินค้าแนะนำ / มาใหม่ 🌟");
        const elements = featuredProducts.map(product => {
             const stockCount = product.downloadUrls.length; // Get count
             return {
                 title: product.name,
                 subtitle: `฿${product.price} | ${product.category} | เหลือ ${stockCount}`, // Display count
                 image_url: product.imageUrl || "https://via.placeholder.com/300x200?text=Featured",
                 buttons: [
                     { type: "postback", title: "ดูรายละเอียด", payload: `PRODUCT_VIEW_${product.id}` },
                     { type: "postback", title: "➕ หยิบใส่ตะกร้า (1 ชิ้น)", payload: `PRODUCT_ADD_TO_CART_${product.id}` }
                 ]
             };
        });
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

// showHelp remains the same conceptually
async function showHelp(sender) {
    try {
        const helpText = `
🤖 คำสั่งช่วยเหลือ & ข้อมูล 🤖

🔹 **คำสั่งพื้นฐาน (พิมพ์ได้เลย):**
   - สินค้า / shop : แสดงหมวดหมู่สินค้า
   - ตะกร้า / cart : ดูสินค้าในตะกร้า
   - ชำระเงิน / checkout : ไปยังหน้าชำระเงิน/ใช้โค้ด
   - แนะนำ / featured : ดูสินค้าแนะนำ/มาใหม่
   - ค้นหา [คำ] : ค้นหาสินค้า (เช่น: ค้นหา script bot)
   - ล้างตะกร้า : ลบสินค้าทั้งหมดในตะกร้า
   - ยกเลิก : ยกเลิกขั้นตอนการชำระเงิน/ใช้โค้ด
   - ช่วยเหลือ / help : แสดงข้อความนี้

🔹 **การจัดการตะกร้า:**
   - ในหน้าตะกร้า จะมีปุ่ม Quick Reply สำหรับลบสินค้าทีละชิ้น

🔹 **การชำระเงิน/รับของ:**
   1. กด 'ชำระเงิน'
   2. เลือกวิธี:
      - โอนเงิน: ทำตามขั้นตอน ส่งสลิป
      - Wallet: ทำตามขั้นตอน ส่งลิงก์ซองอั่งเปา
      - ใช้โค้ด: กรอกโค้ด 32 หลัก ที่ได้รับ
   3. หลังชำระเงิน/ยืนยันโค้ดสำเร็จ ระบบจะส่งโค้ด/ลิงก์สินค้าให้ทางแชทนี้

ติดปัญหา หรือ ต้องการสอบถามเพิ่มเติม? 👇
        `;
        await sendMessage(sender, helpText);
        await sendButtonTemplate(sender, "ติดต่อแอดมิน หรือ กลับไปดูสินค้า:", [
            { type: "web_url", title: "💬 ติดต่อแอดมิน (Facebook)", url: "https://m.me/61555184860915" },
            { type: "postback", title: "กลับไปดูสินค้า", payload: "SHOW_CATEGORIES" }
        ]);
    } catch (error) {
        console.error(`Error in showHelp: ${error.message}`);
        await sendMessage(sender, "ขออภัย เกิดข้อผิดพลาดในการแสดงคำแนะนำ");
    }
}
// --- End Search/Help ---


// --- Facebook Webhook Handling (GET/POST - Unchanged) ---
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('Webhook Verified');
        res.status(200).send(challenge);
    } else {
        console.error('Webhook Verification Failed.');
        res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'page') {
         if (!body.entry || !Array.isArray(body.entry)) {
             console.error("Invalid webhook payload: Missing or invalid 'entry' array.");
             return res.sendStatus(400);
         }
        Promise.all(body.entry.map(async (entry) => {
            if (!entry.messaging || !Array.isArray(entry.messaging)) { return; }
            const webhook_event = entry.messaging[0];
            if (!webhook_event || !webhook_event.sender || !webhook_event.sender.id) { return; }
            const sender_psid = webhook_event.sender.id;
            console.log(`--- Event --- Sender PSID: ${sender_psid}`);
            try {
                 if (webhook_event.message) await handleMessage(sender_psid, webhook_event.message);
                 else if (webhook_event.postback) await handlePostback(sender_psid, webhook_event.postback);
                 // Ignore delivery/read confirmations for now
            } catch (error) { console.error(`Error processing webhook event for ${sender_psid}:`, error); }
        })).then(() => { res.status(200).send('EVENT_RECEIVED'); })
           .catch(err => { console.error("Error processing webhook batch:", err); res.status(500).send('INTERNAL_SERVER_ERROR'); });
    } else { res.sendStatus(404); }
});
// --- End Webhook ---


// --- Message and Postback Handlers (Minor adjustments for cart removal) ---
async function handleMessage(sender_psid, received_message) {
    console.log(`Handling message from ${sender_psid}:`, JSON.stringify(received_message).substring(0, 150) + '...');
    const user = getUserData(sender_psid);

    // 1. Prioritize Checkout Inputs
    if (user.checkoutState) {
        if (received_message.text) {
            const handledInCheckout = await handleCheckoutTextInput(sender_psid, received_message.text);
            if (handledInCheckout) return;
        }
        else if (received_message.attachments?.length > 0 && received_message.attachments[0].type === 'image' && received_message.attachments[0].payload?.url) {
            const handledAsSlip = await handleCheckoutImageInput(sender_psid, received_message.attachments[0].payload.url);
            if (handledAsSlip) return;
        }
        else if (received_message.attachments?.length > 0 && received_message.attachments[0].type === 'fallback' && received_message.attachments[0].payload?.url) {
             const fallbackUrl = received_message.attachments[0].payload.url;
             const ANGPAO_REGEX = /https:\/\/gift\.truemoney\.com\/campaign\/\?v=([a-zA-Z0-9]{35})/;
             if (ANGPAO_REGEX.test(fallbackUrl)) {
                 const handledInCheckout = await handleCheckoutTextInput(sender_psid, fallbackUrl);
                 if (handledInCheckout) return;
             } else {
                if(user.checkoutState.step === 'awaiting_angpao_link') await sendMessage(sender_psid, "กรุณาส่งลิงก์ซองอั่งเปาที่ถูกต้อง หรือกด 'ยกเลิก'");
                else if(user.checkoutState.step === 'awaiting_bank_slip') await sendMessage(sender_psid, "กรุณาส่งรูปสลิป หรือกด 'ยกเลิก'");
                else if(user.checkoutState.step === 'awaiting_redeem_code') await sendMessage(sender_psid, "กรุณาส่งโค้ด 32 หลัก หรือกด 'ยกเลิก'");
                return;
             }
        }
        else if (received_message.text) {
             console.log(`User ${sender_psid} sent text "${received_message.text}" during checkout step ${user.checkoutState.step}. Ignoring.`);
             if (user.checkoutState.step === 'awaiting_angpao_link') await sendMessage(sender_psid, "กรุณาส่งเฉพาะ 'ลิงก์ซองอั่งเปา' หรือกด 'ยกเลิก'");
             else if (user.checkoutState.step === 'awaiting_bank_slip') await sendMessage(sender_psid, "กรุณาส่งเฉพาะ 'รูปสลิป' หรือกด 'ยกเลิก'");
             else if (user.checkoutState.step === 'awaiting_redeem_code') await sendMessage(sender_psid, "กรุณาส่งเฉพาะ 'โค้ด 32 หลัก' หรือกด 'ยกเลิก'");
             return;
        }
    }

    // 2. Handle Quick Replies
    if (received_message.quick_reply?.payload) {
        console.log(`Quick Reply Payload: ${received_message.quick_reply.payload}`);
        await handlePostbackPayload(sender_psid, received_message.quick_reply.payload);
        return;
    }

    // 3. Handle Attachments (General)
    if (received_message.attachments?.length > 0) {
        const attachment = received_message.attachments[0];
        console.log(`Received unhandled attachment type: ${attachment.type}`);
        if (attachment.type === 'image') await sendMessage(sender_psid, "ขอบคุณสำหรับรูปภาพครับ 👍 หากต้องการส่งสลิป กรุณาทำตามขั้นตอนชำระเงินก่อนนะครับ");
        else if (['audio', 'video', 'file'].includes(attachment.type)) await sendMessage(sender_psid, `ขอบคุณสำหรับไฟล์ ${attachment.type} ครับ 😊`);
        else if (attachment.type === 'fallback') await sendMessage(sender_psid, "ได้รับไฟล์แนบที่ไม่รู้จักครับ"); // Adjusted fallback message
        else await sendMessage(sender_psid, "ได้รับไฟล์แนบประเภทที่ไม่รองรับครับ");
        return;
    }

    // 4. Handle Text Messages (General Commands)
    if (received_message.text) {
        let text = received_message.text.trim();
        const textLower = text.toLowerCase();
        console.log(`Received text: "${text}"`);

        if (['hi', 'hello', 'สวัสดี', 'หวัดดี', 'sup'].includes(textLower)) {
            await sendMessage(sender_psid, "สวัสดีครับ! ยินดีให้บริการ พิมพ์ 'สินค้า' เพื่อดูรายการ หรือ 'ช่วยเหลือ' เพื่อดูคำสั่งทั้งหมดครับ 😊");
        } else if (['สินค้า', 'ดูสินค้า', 'products', 'shop', 'menu', '/shop'].includes(textLower)) {
            await showCategories(sender_psid);
        } else if (['ตะกร้า', 'cart', 'ดูตะกร้า', '/cart'].includes(textLower)) {
            await viewCart(sender_psid);
        } else if (['ชำระเงิน', 'checkout', 'payment', '/checkout'].includes(textLower)) {
            await checkout(sender_psid);
        } else if (['ช่วยเหลือ', 'help', 'คำสั่ง', '/help'].includes(textLower)) {
            await showHelp(sender_psid);
        } else if (['แนะนำ', 'featured', '/featured'].includes(textLower)) {
            await showFeaturedProducts(sender_psid);
        } else if (['ล้างตะกร้า', 'clear cart', '/clearcart'].includes(textLower)) {
            await clearCart(sender_psid);
        } else if (['ยกเลิก', 'cancel', '/cancel'].includes(textLower)) {
            await cancelPayment(sender_psid);
        } else if (textLower.startsWith('ค้นหา ') || textLower.startsWith('search ')) {
             const searchTerm = text.substring(textLower.indexOf(' ')+1);
             await searchProducts(sender_psid, searchTerm);
        } else if (['ขอบคุณ', 'thanks', 'thank you'].includes(textLower)) {
             await sendMessage(sender_psid, "ยินดีเสมอครับ! 😊");
        }
        else {
            console.log(`Unrecognized text command: "${text}"`);
            await sendMessage(sender_psid, `ขออภัย ไม่เข้าใจคำสั่ง "${text}"\nลองพิมพ์ 'ช่วยเหลือ' เพื่อดูคำสั่งทั้งหมดนะครับ`);
        }
    } else {
        console.log("Received message without standard text or attachments.");
    }
}

async function handlePostback(sender_psid, received_postback) {
    let payload = received_postback.payload;
    let title = received_postback.title;
    console.log(`Handling postback from ${sender_psid}, Title: "${title}", Payload: ${payload}`);
    await handlePostbackPayload(sender_psid, payload);
}

// Central function to process payloads
async function handlePostbackPayload(sender_psid, payload) {
    const user = getUserData(sender_psid);
    try {
        if (payload === 'GET_STARTED') {
            await sendImageMessage(sender_psid, CONFIG.WELCOME_GIF);
            await sendMessage(sender_psid, "สวัสดีครับ! ยินดีต้อนรับสู่ร้านค้า ยินดีให้บริการครับ 😊");
            await showCategories(sender_psid);
        }
        // Navigation
        else if (payload === 'SHOW_CATEGORIES') await showCategories(sender_psid);
        else if (payload.startsWith('CATEGORY_')) await showProductsByCategory(sender_psid, payload.substring('CATEGORY_'.length), 0);
        else if (payload.startsWith('MORE_PRODUCTS_')) {
             const parts = payload.substring('MORE_PRODUCTS_'.length).split('_');
             const page = parseInt(parts.pop());
             const categoryName = parts.join('_');
             if (!isNaN(page) && categoryName) await showProductsByCategory(sender_psid, categoryName, page);
             else { console.error("Invalid MORE_PRODUCTS payload:", payload); await sendMessage(sender_psid, "ผิดพลาดในการโหลดหน้าถัดไป"); }
        }
        else if (payload.startsWith('PRODUCT_VIEW_')) await showProductDetail(sender_psid, payload.substring('PRODUCT_VIEW_'.length));
        // Cart Management
        else if (payload === 'CART_VIEW') await viewCart(sender_psid);
        else if (payload === 'CART_CLEAR') await clearCart(sender_psid);
        else if (payload.startsWith('PRODUCT_ADD_TO_CART_')) await addToCart(sender_psid, payload.substring('PRODUCT_ADD_TO_CART_'.length));
        else if (payload.startsWith('CART_REMOVE_INSTANCE_')) await removeFromCartInstance(sender_psid, payload.substring('CART_REMOVE_INSTANCE_'.length)); // <= CHANGED
        // Checkout / Payment
        else if (payload === 'CHECKOUT') await checkout(sender_psid);
        else if (payload === 'PAYMENT_ANGPAO') await processPaymentMethod(sender_psid, 'angpao');
        else if (payload === 'PAYMENT_BANK') await processPaymentMethod(sender_psid, 'bank');
        else if (payload === 'PAYMENT_REDEEM_CODE') await processPaymentMethod(sender_psid, 'redeem_code');
        else if (payload === 'CANCEL_PAYMENT') await cancelPayment(sender_psid);
        // Other Actions
        else if (payload === 'HELP') await showHelp(sender_psid);
        else if (payload === 'FEATURED_PRODUCTS') await showFeaturedProducts(sender_psid);
        // Fallback
        else {
            console.warn(`Unhandled payload: "${payload}" from ${sender_psid}`);
            await sendMessage(sender_psid, "ขออภัย ไม่รู้จักคำสั่งนี้");
        }
    } catch (error) {
         console.error(`Error handling payload "${payload}" for ${sender_psid}:`, error);
         await sendMessage(sender_psid, "ขออภัย เกิดข้อผิดพลาดในการประมวลผลคำสั่ง โปรดลองอีกครั้ง หรือติดต่อแอดมิน");
         if (user.checkoutState) await cancelPayment(sender_psid);
         else await showCategories(sender_psid);
    }
}
// --- End Handlers ---


// --- Admin Dashboard Setup and Routes (MODIFIED Products Add/Edit/View) ---
function validateImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return /^(https?:\/\/).+\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url.trim());
}

const viewsDir = path.join(__dirname, 'views');
if (!fs.existsSync(viewsDir)) fs.mkdirSync(viewsDir);
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);


// --- Admin Routes ---
app.get('/admin', (req, res) => {
     try {
        const stats = {
             totalProducts: shopData.products.length,
             totalStockItems: shopData.products.reduce((sum, p) => sum + (p.downloadUrls?.length || 0), 0), // Sum of all lines
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
        res.render('dashboard', { stats }); // Pass new stats
     } catch (error) {
         console.error("Error rendering admin dashboard:", error);
         res.status(500).send("Error loading dashboard data.");
     }
});

app.get('/admin/products', (req, res) => {
     try {
        const sortedProducts = [...shopData.products].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        res.render('products', { products: sortedProducts, categories: shopData.categories });
     } catch (error) {
         console.error("Error rendering products page:", error);
         res.status(500).send("Error loading product data.");
     }
});

app.post('/admin/products/add', (req, res) => {
    try {
        const { name, price, /* stock REMOVED */ category, description, language, version, imageUrl, downloadUrlsText } = req.body;

        // --- Input Validation ---
        if (!name || !price /* REMOVED stock */ || !category || !imageUrl || !downloadUrlsText) {
            return res.status(400).send('Missing required fields (Name, Price, Category, Image URL, Download Info).');
        }
        if (isNaN(parseFloat(price)) || parseFloat(price) < 0) return res.status(400).send('Invalid price.');
        // REMOVED Stock validation
        if (!validateImageUrl(imageUrl)) return res.status(400).send('Invalid image URL format.');
        if (!shopData.categories.some(cat => cat.name === category)) return res.status(400).send('Selected category does not exist.');
        // --- End Validation ---

        // NEW: Process downloadUrlsText into an array
        const downloadUrls = downloadUrlsText
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0); // Filter out empty lines

        if (downloadUrls.length === 0) {
            return res.status(400).send('Download Info cannot be empty. Each line represents one stock item.');
        }

        const newProduct = {
            id: `P-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            name: name.trim(),
            price: parseFloat(price),
            // stock: REMOVED
            category: category,
            description: description ? description.trim() : '',
            language: language ? language.trim() : '',
            version: version ? version.trim() : '',
            imageUrl: imageUrl.trim(),
            downloadUrls: downloadUrls, // Use the processed array
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        shopData.products.push(newProduct);
        saveShopData();
        console.log(`Admin: Product added - ${newProduct.name} (ID: ${newProduct.id}), Stock: ${newProduct.downloadUrls.length}`);
        res.redirect('/admin/products');
    } catch (error) {
        console.error("Error adding product via admin:", error);
        res.status(500).send("Error processing request.");
    }
});

app.post('/admin/products/edit/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { name, price, /* stock REMOVED */ category, description, language, version, imageUrl, downloadUrlsText } = req.body;

        // --- Input Validation ---
        if (!name || !price /* REMOVED stock */ || !category || !imageUrl || !downloadUrlsText) return res.status(400).send('Missing required fields.');
        if (isNaN(parseFloat(price)) || parseFloat(price) < 0) return res.status(400).send('Invalid price.');
        // REMOVED Stock validation
        if (!validateImageUrl(imageUrl)) return res.status(400).send('Invalid image URL format.');
        if (!shopData.categories.some(cat => cat.name === category)) return res.status(400).send('Selected category does not exist.');
        // --- End Validation ---

         // NEW: Process downloadUrlsText
         const downloadUrls = downloadUrlsText
             .split('\n')
             .map(line => line.trim())
             .filter(line => line.length > 0);

         if (downloadUrls.length === 0) {
            return res.status(400).send('Download Info cannot be empty. Each line represents one stock item.');
        }

        const productIndex = shopData.products.findIndex(p => p.id === id);
        if (productIndex === -1) return res.status(404).send('Product not found.');

        // Update product data
        shopData.products[productIndex] = {
            ...shopData.products[productIndex],
            name: name.trim(),
            price: parseFloat(price),
            // stock: REMOVED
            category: category,
            description: description ? description.trim() : '',
            language: language ? language.trim() : '',
            version: version ? version.trim() : '',
            imageUrl: imageUrl.trim(),
            downloadUrls: downloadUrls, // Use the processed array
            updatedAt: new Date().toISOString()
        };
        // Remove legacy fields if they somehow persist
        delete shopData.products[productIndex].stock;
        delete shopData.products[productIndex].downloadUrl;

        saveShopData();
        console.log(`Admin: Product edited - ${shopData.products[productIndex].name} (ID: ${id}), Stock: ${shopData.products[productIndex].downloadUrls.length}`);
        res.redirect('/admin/products');
    } catch (error) {
        console.error(`Error editing product ${req.params.id} via admin:`, error);
        res.status(500).send("Error processing request.");
    }
});

// Delete route remains the same
app.post('/admin/products/delete/:id', (req, res) => {
    try {
        const { id } = req.params;
        const initialLength = shopData.products.length;
        shopData.products = shopData.products.filter(p => p.id !== id);
        if (shopData.products.length < initialLength) {
            saveShopData();
            console.log(`Admin: Product deleted - ID ${id}`);
        } else return res.status(404).send('Product not found.');
        res.redirect('/admin/products');
    } catch (error) {
        console.error(`Error deleting product ${req.params.id} via admin:`, error);
        res.status(500).send("Error processing request.");
    }
});

// Categories routes remain the same
app.get('/admin/categories', (req, res) => {
     try {
        const categoriesWithCount = shopData.categories.map(cat => ({
            ...cat,
            productCount: shopData.products.filter(p => p.category === cat.name).length
        }));
         const error = req.query.error;
        res.render('categories', { categories: categoriesWithCount, error: error });
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
        if (shopData.categories.some(cat => cat.name.toLowerCase() === trimmedName.toLowerCase())) return res.status(400).send(`Category "${trimmedName}" exists.`);
        if (imageUrl && !validateImageUrl(imageUrl)) return res.status(400).send('Invalid image URL format.');
        shopData.categories.push({ name: trimmedName, imageUrl: imageUrl ? imageUrl.trim() : '', description: description ? description.trim() : '' });
        shopData.categories.sort((a, b) => a.name.localeCompare(b.name));
        saveShopData();
        console.log(`Admin: Category added - ${trimmedName}`);
        res.redirect('/admin/categories');
    } catch (error) { console.error("Error adding category:", error); res.status(500).send("Error."); }
});

app.post('/admin/categories/edit', (req, res) => {
    try {
        const { originalName, newName, imageUrl, description } = req.body;
        if (!originalName || !newName || !newName.trim()) return res.status(400).send('Names required.');
        const trimmedNewName = newName.trim();
        if (trimmedNewName.toLowerCase() !== originalName.toLowerCase() && shopData.categories.some(cat => cat.name.toLowerCase() === trimmedNewName.toLowerCase())) return res.status(400).send(`Name "${trimmedNewName}" exists.`);
        if (imageUrl && !validateImageUrl(imageUrl)) return res.status(400).send('Invalid image URL format.');
        const categoryIndex = shopData.categories.findIndex(cat => cat.name === originalName);
        if (categoryIndex === -1) return res.status(404).send('Category not found.');
        const oldName = shopData.categories[categoryIndex].name;
        shopData.categories[categoryIndex] = { name: trimmedNewName, imageUrl: imageUrl ? imageUrl.trim() : (shopData.categories[categoryIndex].imageUrl || ''), description: description ? description.trim() : (shopData.categories[categoryIndex].description || '') };
        if (trimmedNewName !== oldName) {
             let productsUpdated = 0;
             shopData.products.forEach(product => { if (product.category === oldName) { product.category = trimmedNewName; product.updatedAt = new Date().toISOString(); productsUpdated++; } });
             console.log(`Admin: Updated ${productsUpdated} products from category "${oldName}" to "${trimmedNewName}"`);
        }
        shopData.categories.sort((a, b) => a.name.localeCompare(b.name));
        saveShopData();
        console.log(`Admin: Category edited - "${oldName}" to "${trimmedNewName}"`);
        res.redirect('/admin/categories');
    } catch (error) { console.error("Error editing category:", error); res.status(500).send("Error."); }
});

app.post('/admin/categories/delete/:name', (req, res) => {
    try {
        const decodedName = decodeURIComponent(req.params.name);
        const productsInCategory = shopData.products.filter(p => p.category === decodedName);
        if (productsInCategory.length > 0) {
            console.warn(`Admin: Cannot delete category "${decodedName}" with ${productsInCategory.length} products.`);
            return res.redirect('/admin/categories?error=delete_failed_in_use');
        }
        const initialLength = shopData.categories.length;
        shopData.categories = shopData.categories.filter(cat => cat.name !== decodedName);
        if (shopData.categories.length < initialLength) {
            saveShopData();
            console.log(`Admin: Category deleted - ${decodedName}`);
        } else return res.status(404).send('Category not found.');
        res.redirect('/admin/categories');
    } catch (error) { console.error(`Error deleting category ${decodeURIComponent(req.params.name)}:`, error); res.status(500).send("Error."); }
});

// Orders routes remain the same (displaying deliveredData might need template adjustment)
app.get('/admin/orders', (req, res) => {
     try {
        const sortedOrders = [...shopData.orders]
                             .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.render('orders', { orders: sortedOrders }); // Pass orders to the template
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
                 console.log(`Admin: Order status updated - ID ${id} set to ${status}`);
             }
             res.redirect('/admin/orders');
        } else res.status(404).send('Order not found.');
    } catch (error) { console.error(`Error updating order status ${req.params.id}:`, error); res.status(500).send("Error."); }
});


// Redemption Codes routes remain the same
app.get('/admin/codes', (req, res) => {
     try {
        const sortedCodes = [...validRedemptionCodes].sort();
        res.render('codes', { codes: sortedCodes, message: req.query.message });
     } catch (error) { console.error("Error rendering codes page:", error); res.status(500).send("Error."); }
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
            code = code.trim();
            if (code.length !== CODE_LENGTH) message = `Error: Manual code must be ${CODE_LENGTH} characters.`;
            else if (validRedemptionCodes.includes(code)) message = `Error: Code "${code}" exists.`;
            else { validRedemptionCodes.push(code); addedCount++; }
        } else {
            if (count > 1000) count = 1000;
            if (count < 1) message = 'Error: Specify code or count (1-1000).';
            else {
                for (let i = 0; i < count; i++) {
                    let attempts = 0, generatedCode;
                    do {
                         generatedCode = crypto.randomBytes(16).toString('hex').toUpperCase(); attempts++;
                    } while (validRedemptionCodes.includes(generatedCode) && attempts < 10);
                    if (attempts < 10) { validRedemptionCodes.push(generatedCode); addedCount++; }
                    else { console.warn("Failed unique code generation attempt."); failedCodes.push(`Attempt ${i+1}`); }
                }
            }
        }
        if (addedCount > 0) {
             validRedemptionCodes.sort();
             saveValidRedemptionCodes();
             console.log(`Admin: Added ${addedCount} redemption code(s).`);
             message = `Successfully added ${addedCount} code(s).`;
             if (failedCodes.length > 0) message += ` Failed to generate ${failedCodes.length}.`;
        } else if (!message) message = "No codes added. Provide valid code or count.";
        res.redirect(`/admin/codes?message=${encodeURIComponent(message)}`);
    } catch (error) { console.error("Error adding codes:", error); res.status(500).send("Error."); }
});

app.post('/admin/codes/delete/:code', (req, res) => {
    try {
        const { code } = req.params;
        const initialLength = validRedemptionCodes.length;
        validRedemptionCodes = validRedemptionCodes.filter(c => c !== code);
        if (validRedemptionCodes.length < initialLength) {
            saveValidRedemptionCodes();
            console.log(`Admin: Redemption code deleted - ${code}`);
             res.redirect('/admin/codes?message=' + encodeURIComponent(`Code "${code}" deleted.`));
        } else res.redirect('/admin/codes?message=' + encodeURIComponent(`Error: Code "${code}" not found.`));
    } catch (error) { console.error(`Error deleting code ${req.params.code}:`, error); res.status(500).send("Error."); }
});
// --- End Admin ---


// --- EJS Template Creation (MODIFIED Dashboard, Products, Orders) ---
const templates = {
    // --- DASHBOARD (Added Total Stock Items) ---
    'dashboard.ejs': `
<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>แดชบอร์ด - ระบบจัดการร้านค้า</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"><style>.card-icon { font-size: 2.5rem; } .card { transition: transform 0.2s ease-in-out; } .card:hover { transform: translateY(-5px); box-shadow: 0 4px 8px rgba(0,0,0,0.1); } body { padding-top: 70px; background-color: #f8f9fa; } .card-footer span { margin-right: auto; } .table th, .table td { vertical-align: middle; } </style></head><body><%- include('navbar') %><div class="container mt-4"><h2 class="mb-4"><i class="bi bi-speedometer2"></i> แดชบอร์ดภาพรวม</h2><div class="row g-4 mb-4"> <div class="col-md-3 col-sm-6"><div class="card text-white bg-primary h-100"><div class="card-body d-flex justify-content-between align-items-center"><div><h5 class="card-title">ชนิดสินค้า</h5><h2 class="card-text display-6"><%= stats.totalProducts %></h2><small>สินค้าในสต็อก: <%= stats.totalStockItems %></small></div><i class="bi bi-box-seam card-icon opacity-75"></i></div><a href="/admin/products" class="card-footer text-white text-decoration-none d-flex justify-content-between align-items-center"><span>จัดการสินค้า</span> <i class="bi bi-arrow-right-circle"></i></a></div></div> <div class="col-md-3 col-sm-6"><div class="card text-white bg-info h-100"><div class="card-body d-flex justify-content-between align-items-center"><div><h5 class="card-title">หมวดหมู่</h5><h2 class="card-text display-6"><%= stats.totalCategories %></h2></div><i class="bi bi-tags card-icon opacity-75"></i></div><a href="/admin/categories" class="card-footer text-white text-decoration-none d-flex justify-content-between align-items-center"><span>จัดการหมวดหมู่</span> <i class="bi bi-arrow-right-circle"></i></a></div></div> <div class="col-md-3 col-sm-6"><div class="card text-white bg-success h-100"><div class="card-body d-flex justify-content-between align-items-center"><div><h5 class="card-title">คำสั่งซื้อสำเร็จ</h5><h2 class="card-text display-6"><%= stats.completedOrders %> / <%= stats.totalOrders %></h2></div><i class="bi bi-cart-check card-icon opacity-75"></i></div><a href="/admin/orders" class="card-footer text-white text-decoration-none d-flex justify-content-between align-items-center"><span>ดูคำสั่งซื้อ</span> <i class="bi bi-arrow-right-circle"></i></a></div></div> <div class="col-md-3 col-sm-6"><div class="card text-white bg-warning h-100"><div class="card-body d-flex justify-content-between align-items-center"><div><h5 class="card-title">รายรับรวม</h5><h3 class="card-text">฿<%= stats.totalRevenue %></h3></div><i class="bi bi-currency-bitcoin card-icon opacity-75"></i></div><div class="card-footer text-white"><small>จากคำสั่งซื้อที่สำเร็จ</small></div></div></div></div><div class="card mt-4"><div class="card-header bg-light"><h4><i class="bi bi-clock-history"></i> คำสั่งซื้อล่าสุด (5 รายการ)</h4></div><div class="card-body p-0"><div class="table-responsive"><table class="table table-striped table-hover mb-0"><thead class="table-light"><tr><th>รหัส</th><th>ลูกค้า (PSID)</th><th>ยอดรวม</th><th>ช่องทาง</th><th>สถานะ</th><th>วันที่</th></tr></thead><tbody><% if (stats.recentOrders.length > 0) { %><% stats.recentOrders.forEach(order => { %><tr><td><a href="/admin/orders#order-<%= order.id %>" title="<%= order.id %>"><%= order.id.slice(0, 12) %>...</a></td><td><span title="<%= order.userId %>"><%= order.userId.slice(0, 6) %>...<%= order.userId.slice(-4) %></span></td><td>฿<%= order.totalAmount.toFixed(2) %></td><td><%= order.paymentMethod %></td><td><span class="badge bg-<%= order.status === 'completed' ? 'success' : (order.status === 'cancelled' ? 'danger' : (order.status === 'pending' ? 'warning' : 'secondary')) %> text-capitalize"><%= order.status %></span></td><td><%= new Date(order.createdAt).toLocaleString('th-TH', {dateStyle:'short', timeStyle:'short'}) %></td></tr><% }) %><% } else { %><tr><td colspan="6" class="text-center text-muted py-3">ยังไม่มีคำสั่งซื้อ</td></tr><% } %></tbody></table></div></div><div class="card-footer text-end bg-light border-top-0"><a href="/admin/orders" class="btn btn-outline-primary btn-sm">ดูคำสั่งซื้อทั้งหมด <i class="bi bi-arrow-right"></i></a></div></div></div><script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script></body></html>
`,
    // --- PRODUCTS (Removed Stock field, uses Download Info lines) ---
    'products.ejs': `
<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>จัดการสินค้า - ระบบจัดการร้านค้า</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"><style>.product-image-thumb { width: 60px; height: 60px; object-fit: cover; border-radius: 4px;} .image-preview { max-width: 150px; max-height: 100px; margin-top: 10px; display: none; border: 1px solid #ddd; padding: 2px; border-radius: 4px; } th, td { vertical-align: middle; } body { padding-top: 70px; background-color: #f8f9fa; } .btn-action form { display: inline; } </style></head><body><%- include('navbar') %><div class="container mt-4"><div class="d-flex justify-content-between align-items-center mb-3"><h2><i class="bi bi-box-seam"></i> จัดการสินค้า (<%= products.length %> ชนิด)</h2><button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addProductModal"><i class="bi bi-plus-circle"></i> เพิ่มสินค้า</button></div><div class="card shadow-sm"><div class="card-body p-0"><div class="table-responsive"><table class="table table-striped table-hover mb-0"><thead class="table-light"><tr><th>รูป</th><th>ชื่อ</th><th>ราคา (฿)</th><th>คงเหลือ (ชิ้น)</th><th>หมวดหมู่</th><th>วันที่เพิ่ม/แก้ไข</th><th class="text-center">จัดการ</th></tr></thead><tbody><% if (products.length > 0) { %><% products.forEach(product => { const stockCount = product.downloadUrls?.length || 0; %><tr><td><img src="<%= product.imageUrl %>" alt="Image" class="product-image-thumb" onerror="this.src='https://via.placeholder.com/60?text=N/A'; this.alt='No Image'"></td><td><%= product.name %><br><small class="text-muted">ID: <%= product.id %></small></td><td><%= product.price.toFixed(2) %></td><td><span class="badge fs-6 bg-<%= stockCount > 5 ? 'success' : (stockCount > 0 ? 'warning' : 'danger') %>"><%= stockCount %></span></td><td><small><%= product.category %></small></td><td><small title="Created: <%= new Date(product.createdAt).toLocaleString('th-TH') %>\nUpdated: <%= new Date(product.updatedAt).toLocaleString('th-TH') %>"><%= new Date(product.updatedAt || product.createdAt).toLocaleDateString('th-TH', { year:'2-digit', month: 'short', day:'numeric'}) %></small></td><td class="text-center btn-action"><button class="btn btn-sm btn-warning me-1" data-bs-toggle="modal" data-bs-target="#editProductModal<%= product.id.replace(/[^a-zA-Z0-9]/g, '') %>" title="แก้ไข"><i class="bi bi-pencil-square"></i></button><form method="POST" action="/admin/products/delete/<%= product.id %>"><button type="submit" class="btn btn-sm btn-danger" onclick="return confirm('ยืนยันลบสินค้า: <%= product.name %> ?')" title="ลบ"><i class="bi bi-trash3"></i></button></form></td></tr><% }) %><% } else { %><tr><td colspan="7" class="text-center text-muted py-3">ยังไม่มีสินค้าในระบบ</td></tr><% } %></tbody></table></div></div></div></div><!-- Add Product Modal --><div class="modal fade" id="addProductModal" tabindex="-1" aria-labelledby="addProductModalLabel" aria-hidden="true"><div class="modal-dialog modal-lg"><div class="modal-content"><form method="POST" action="/admin/products/add" id="addProductForm"><div class="modal-header"><h5 class="modal-title" id="addProductModalLabel">เพิ่มสินค้าใหม่</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div><div class="modal-body"><div class="row"><div class="col-md-8 mb-3"><label class="form-label">ชื่อสินค้า*</label><input type="text" name="name" class="form-control" required></div><div class="col-md-4 mb-3"><label class="form-label">ราคา (฿)*</label><input type="number" name="price" class="form-control" step="0.01" min="0" required></div></div><!-- Stock field removed --><div class="mb-3"><label class="form-label">หมวดหมู่*</label><select name="category" class="form-select" required><option value="" disabled <%= categories.length === 0 ? '' : 'selected' %>>-- เลือกหมวดหมู่ --</option><% categories.forEach(c => { %><option value="<%= c.name %>"><%= c.name %></option><% }) %><% if(categories.length === 0){ %><option disabled>!! กรุณาเพิ่มหมวดหมู่ก่อน !!</option><% } %></select></div><div class="mb-3"><label class="form-label">รายละเอียดสินค้า</label><textarea name="description" class="form-control" rows="2"></textarea></div><div class="row"><div class="col-md-6 mb-3"><label class="form-label">ภาษา (ถ้ามี)</label><input type="text" name="language" class="form-control"></div><div class="col-md-6 mb-3"><label class="form-label">เวอร์ชัน (ถ้ามี)</label><input type="text" name="version" class="form-control"></div></div><div class="mb-3"><label class="form-label">URL รูปภาพ*</label><input type="url" name="imageUrl" class="form-control image-url-input" required placeholder="https://..."><img src="" class="image-preview"><div class="form-text text-muted">ต้องเป็น https และลงท้ายด้วย .jpg, .png, .gif, .webp</div></div><div class="mb-3"><label class="form-label">ข้อมูลส่งลูกค้า (ลิงก์/โค้ด)*</label><textarea name="downloadUrlsText" class="form-control" required rows="5" placeholder="ใส่ข้อมูล 1 บรรทัดต่อ 1 ชิ้น เช่น โค้ด, ลิงก์ดาวน์โหลดเฉพาะ"></textarea><div class="form-text text-danger fw-bold">สำคัญ: แต่ละบรรทัด คือ 1 ชิ้นในสต็อก บรรทัดว่างจะถูกข้าม</div></div></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button><button type="submit" class="btn btn-primary" <%= categories.length === 0 ? 'disabled' : '' %>>บันทึกสินค้า</button></div></form></div></div></div><!-- Edit Product Modals --><% products.forEach(product => { %><div class="modal fade" id="editProductModal<%= product.id.replace(/[^a-zA-Z0-9]/g, '') %>" tabindex="-1" aria-labelledby="editProductModalLabel<%= product.id.replace(/[^a-zA-Z0-9]/g, '') %>" aria-hidden="true"><div class="modal-dialog modal-lg"><div class="modal-content"><form method="POST" action="/admin/products/edit/<%= product.id %>"><div class="modal-header"><h5 class="modal-title" id="editProductModalLabel<%= product.id.replace(/[^a-zA-Z0-9]/g, '') %>">แก้ไขสินค้า: <%= product.name %></h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div><div class="modal-body"><div class="row"><div class="col-md-8 mb-3"><label class="form-label">ชื่อ*</label><input type="text" name="name" class="form-control" value="<%= product.name %>" required></div><div class="col-md-4 mb-3"><label class="form-label">ราคา*</label><input type="number" name="price" class="form-control" step="0.01" min="0" value="<%= product.price %>" required></div></div><!-- Stock field removed --><div class="mb-3"><label class="form-label">หมวดหมู่*</label><select name="category" class="form-select" required><% categories.forEach(c => { %><option value="<%= c.name %>" <%= c.name === product.category ? 'selected' : '' %>><%= c.name %></option><% }) %><% if(categories.length === 0){ %><option disabled>!! ไม่มีหมวดหมู่ !!</option><% } %></select></div><div class="mb-3"><label class="form-label">รายละเอียด</label><textarea name="description" class="form-control" rows="2"><%= product.description %></textarea></div><div class="row"><div class="col-md-6 mb-3"><label class="form-label">ภาษา</label><input type="text" name="language" class="form-control" value="<%= product.language || '' %>"></div><div class="col-md-6 mb-3"><label class="form-label">เวอร์ชัน</label><input type="text" name="version" class="form-control" value="<%= product.version || '' %>"></div></div><div class="mb-3"><label class="form-label">URL รูปภาพ*</label><input type="url" name="imageUrl" class="form-control image-url-input" value="<%= product.imageUrl %>" required><img src="<%= product.imageUrl %>" class="image-preview" style="display:block;"><div class="form-text text-muted">ต้องเป็น https และลงท้ายด้วย .jpg, .png, .gif, .webp</div></div><div class="mb-3"><label class="form-label">ข้อมูลส่งลูกค้า (ลิงก์/โค้ด)*</label><textarea name="downloadUrlsText" class="form-control" required rows="5"><%= product.downloadUrls.join('\\n') %></textarea><div class="form-text text-danger fw-bold">สำคัญ: แต่ละบรรทัด คือ 1 ชิ้นในสต็อก บรรทัดว่างจะถูกข้าม การแก้ไขจะแทนที่ข้อมูลเดิมทั้งหมด</div></div></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button><button type="submit" class="btn btn-primary">บันทึกการเปลี่ยนแปลง</button></div></form></div></div></div><% }) %><script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script><script>document.addEventListener('DOMContentLoaded', function() { const setupPreview = (modal) => { const urlInput = modal.querySelector('.image-url-input'); const preview = modal.querySelector('.image-preview'); if (!urlInput || !preview) return; const update = () => { const url = urlInput.value.trim(); const isValid = url && /^(https?:\/\/).+\\.(jpg|jpeg|png|gif|webp)(\\?.*)?$/i.test(url); if (isValid) { preview.src = url; preview.style.display = 'block'; urlInput.classList.remove('is-invalid'); } else { preview.style.display = 'none'; if (url) urlInput.classList.add('is-invalid'); else urlInput.classList.remove('is-invalid'); }}; urlInput.addEventListener('input', update); update(); }; document.querySelectorAll('.modal').forEach(setupPreview); });</script></body></html>
`,
    // --- CATEGORIES (Unchanged template) ---
    'categories.ejs': `
<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>จัดการหมวดหมู่ - ระบบจัดการร้านค้า</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"><style>.category-image-thumb { width: 50px; height: 50px; object-fit: cover; border-radius: 4px; margin-right: 10px; background-color: #eee; } th, td { vertical-align: middle; } .alert-tooltip { cursor: help; } body { padding-top: 70px; background-color: #f8f9fa;} .btn-action form { display: inline; } </style></head><body><%- include('navbar') %><div class="container mt-4"><div class="d-flex justify-content-between align-items-center mb-3"><h2><i class="bi bi-tags"></i> จัดการหมวดหมู่ (<%= categories.length %> รายการ)</h2><button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addCategoryModal"><i class="bi bi-plus-circle"></i> เพิ่มหมวดหมู่</button></div><% if (typeof error !== 'undefined' && error === 'delete_failed_in_use') { %><div class="alert alert-danger alert-dismissible fade show" role="alert"><strong><i class="bi bi-exclamation-triangle-fill"></i> ลบไม่สำเร็จ!</strong> ไม่สามารถลบหมวดหมู่ได้เนื่องจากมีสินค้าใช้งานอยู่ กรุณาย้ายสินค้าออกก่อน<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div><% } %><div class="card shadow-sm"><div class="card-body p-0"><div class="table-responsive"><table class="table table-hover mb-0"><thead class="table-light"><tr><th>รูป</th><th>ชื่อหมวดหมู่</th><th>รายละเอียด</th><th class="text-center">จำนวนสินค้า</th><th class="text-center">จัดการ</th></tr></thead><tbody><% if (categories.length > 0) { %><% categories.forEach(category => { %><tr><td><img src="<%= category.imageUrl || 'https://via.placeholder.com/50/dee2e6/6c757d?text=N/A' %>" alt="Img" class="category-image-thumb"></td><td><%= category.name %></td><td><small><%= category.description || '-' %></small></td><td class="text-center"><%= category.productCount %></td><td class="text-center btn-action"><button class="btn btn-sm btn-warning me-1" data-bs-toggle="modal" data-bs-target="#editCategoryModal<%= category.name.replace(/[^a-zA-Z0-9]/g, '') %>" title="แก้ไข"><i class="bi bi-pencil-square"></i></button><form method="POST" action="/admin/categories/delete/<%= encodeURIComponent(category.name) %>"><button type="submit" class="btn btn-sm btn-danger" <%= category.productCount > 0 ? 'disabled' : '' %> onclick="return confirm('ยืนยันลบหมวดหมู่: <%= category.name %> ? (ต้องไม่มีสินค้าในหมวดนี้)')" title="<%= category.productCount > 0 ? 'ไม่สามารถลบได้ มีสินค้าอยู่' : 'ลบหมวดหมู่' %>"><i class="bi bi-trash3"></i></button></form></td></tr><% }) %><% } else { %><tr><td colspan="5" class="text-center text-muted py-3">ยังไม่มีหมวดหมู่</td></tr><% } %></tbody></table></div></div></div></div><!-- Add/Edit Modals (same as before) --><div class="modal fade" id="addCategoryModal" tabindex="-1" aria-labelledby="addCategoryModalLabel" aria-hidden="true"><div class="modal-dialog"><div class="modal-content"><form method="POST" action="/admin/categories/add"><div class="modal-header"><h5 class="modal-title" id="addCategoryModalLabel">เพิ่มหมวดหมู่ใหม่</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div><div class="modal-body"><div class="mb-3"><label class="form-label">ชื่อหมวดหมู่*</label><input type="text" name="name" class="form-control" required></div><div class="mb-3"><label class="form-label">URL รูปภาพ (ถ้ามี)</label><input type="url" name="imageUrl" class="form-control image-url-input" placeholder="https://..."><img src="" class="image-preview"><div class="form-text text-muted">ต้องเป็น https และลงท้ายด้วย .jpg, .png, .gif, .webp</div></div><div class="mb-3"><label class="form-label">รายละเอียด (ถ้ามี)</label><textarea name="description" class="form-control" rows="2"></textarea></div></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button><button type="submit" class="btn btn-primary">เพิ่มหมวดหมู่</button></div></form></div></div></div><% categories.forEach(category => { %><div class="modal fade" id="editCategoryModal<%= category.name.replace(/[^a-zA-Z0-9]/g, '') %>" tabindex="-1" aria-labelledby="editCategoryModalLabel<%= category.name.replace(/[^a-zA-Z0-9]/g, '') %>" aria-hidden="true"><div class="modal-dialog"><div class="modal-content"><form method="POST" action="/admin/categories/edit"><input type="hidden" name="originalName" value="<%= category.name %>"><div class="modal-header"><h5 class="modal-title" id="editCategoryModalLabel<%= category.name.replace(/[^a-zA-Z0-9]/g, '') %>">แก้ไขหมวดหมู่: <%= category.name %></h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div><div class="modal-body"><div class="mb-3"><label class="form-label">ชื่อใหม่*</label><input type="text" name="newName" class="form-control" value="<%= category.name %>" required></div><div class="mb-3"><label class="form-label">URL รูปภาพ</label><input type="url" name="imageUrl" class="form-control image-url-input" value="<%= category.imageUrl %>"><img src="<%= category.imageUrl %>" class="image-preview" style="<%= category.imageUrl ? 'display:block;' : '' %>"><div class="form-text text-muted">ต้องเป็น https และลงท้ายด้วย .jpg, .png, .gif, .webp</div></div><div class="mb-3"><label class="form-label">รายละเอียด</label><textarea name="description" class="form-control" rows="2"><%= category.description %></textarea></div><div class="alert alert-warning small p-2" role="alert"><i class="bi bi-exclamation-triangle-fill"></i> การเปลี่ยนชื่อหมวดหมู่ จะอัปเดตสินค้าทั้งหมดที่อยู่ในหมวดหมู่นี้โดยอัตโนมัติ</div></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button><button type="submit" class="btn btn-primary">บันทึกการเปลี่ยนแปลง</button></div></form></div></div></div><% }) %><script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script><script>document.addEventListener('DOMContentLoaded', function() { const setupPreview = (modal) => { const urlInput = modal.querySelector('.image-url-input'); const preview = modal.querySelector('.image-preview'); if (!urlInput || !preview) return; const update = () => { const url = urlInput.value.trim(); const isValid = url && /^(https?:\/\/).+\\.(jpg|jpeg|png|gif|webp)(\\?.*)?$/i.test(url); if (isValid) { preview.src = url; preview.style.display = 'block'; urlInput.classList.remove('is-invalid'); } else { preview.style.display = 'none'; preview.src = ''; if (url) urlInput.classList.add('is-invalid'); else urlInput.classList.remove('is-invalid'); }}; urlInput.addEventListener('input', update); }; document.querySelectorAll('.modal').forEach(setupPreview); const alertElement = document.querySelector('.alert-danger'); if(alertElement){ const alert = new bootstrap.Alert(alertElement); setTimeout(() => { alert.close(); }, 10000); } });</script></body></html>
`,
    // --- ORDERS (Display deliveredData per item) ---
    'orders.ejs': `
<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>จัดการคำสั่งซื้อ - ระบบจัดการร้านค้า</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"><style>th, td { vertical-align: middle; font-size: 0.9rem; } .item-list { list-style: none; padding-left: 0; margin-bottom: 0; } .item-list li { font-size: 0.85rem; } .delivered-data { font-family: monospace; font-size: 0.8rem; color: #6c757d; word-break: break-all; max-width: 200px; display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; cursor: help;} .status-select { min-width: 120px; } .order-row { border-left: 4px solid transparent; transition: border-color 0.3s ease, background-color 0.3s ease; } .order-row:target { border-left-color: #0d6efd; background-color: #e7f1ff; animation: highlight 1.5s ease-out; } body { padding-top: 70px; background-color: #f8f9fa; } .confirmation-link { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; vertical-align: middle; } @keyframes highlight{ 0%{ background-color: #e7f1ff; } 100%{ background-color: transparent; }} </style></head><body><%- include('navbar') %><div class="container mt-4"><h2><i class="bi bi-receipt"></i> จัดการคำสั่งซื้อ (<%= orders.length %> รายการ)</h2><div class="card mt-3 shadow-sm"><div class="card-body p-0"><div class="table-responsive"><table class="table table-hover table-bordered mb-0"><thead class="table-light"><tr><th>#</th><th>รหัสคำสั่งซื้อ</th><th>ลูกค้า (PSID)</th><th>รายการสินค้า (ที่ส่งมอบ)</th><th>ยอด(฿)</th><th>ช่องทาง</th><th>สถานะ</th><th>วันที่สั่งซื้อ</th><th class="text-center">ข้อมูลยืนยัน</th></tr></thead><tbody><% if (orders.length > 0) { %><% orders.forEach((order, index) => { %><tr class="order-row" id="order-<%= order.id %>"><td><%= index + 1 %></td><td><small title="<%= order.id %>"><%= order.id.substring(0, 16) %>...</small></td><td><small title="<%= order.userId %>"><%= order.userId.substring(0, 6) %>...<%= order.userId.slice(-4) %></small></td><td><ul class="item-list"><% order.items.forEach(item => { %><li><small><%= item.name %> <span class="delivered-data" title="ข้อมูลที่ส่ง: <%= item.deliveredData %>">(<%= item.deliveredData.length > 20 ? item.deliveredData.substring(0,17)+'...' : item.deliveredData %>)</span></small></li><% }) %></ul></td><td><b><%= order.totalAmount.toFixed(2) %></b></td><td><span class="badge bg-<%= order.paymentMethod === 'angpao' ? 'danger' : (order.paymentMethod === 'bank' ? 'info' : (order.paymentMethod === 'redeem_code' ? 'primary' : 'secondary')) %> text-capitalize"><i class="bi bi-<%= order.paymentMethod === 'angpao' ? 'gift' : (order.paymentMethod === 'bank' ? 'bank' : (order.paymentMethod === 'redeem_code' ? 'key' : 'question-circle')) %>"></i> <%= order.paymentMethod %></span></td><td><form method="POST" action="/admin/orders/status/<%= order.id %>" class="d-inline-block"><select name="status" class="form-select form-select-sm status-select" onchange="this.form.submit()" title="เปลี่ยนสถานะคำสั่งซื้อ"><option value="pending" <%= order.status === 'pending' ? 'selected' : '' %>>⏳ รอดำเนินการ</option><option value="processing" <%= order.status === 'processing' ? 'selected' : '' %>>🔄 กำลังเตรียม</option><option value="completed" <%= order.status === 'completed' ? 'selected' : '' %>>✔️ สำเร็จ</option><option value="cancelled" <%= order.status === 'cancelled' ? 'selected' : '' %>>❌ ยกเลิก</option><option value="shipped" <%= order.status === 'shipped' ? 'selected' : '' %>>🚚 จัดส่งแล้ว</option><option value="refunded" <%= order.status === 'refunded' ? 'selected' : '' %>>💸 คืนเงิน</option></select></form></td><td><small title="Updated: <%= new Date(order.updatedAt).toLocaleString('th-TH') %>"><%= new Date(order.createdAt).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short'}) %></small></td><td class="text-center"><% if (order.paymentConfirmation && (order.paymentConfirmation.startsWith('http'))) { %><a href="<%= order.paymentConfirmation %>" target="_blank" class="btn btn-sm btn-outline-secondary confirmation-link" title="ดูหลักฐาน: <%= order.paymentConfirmation %>"><i class="bi bi-link-45deg"></i> ลิงก์/สลิป</a><% } else if (order.paymentConfirmation) { %><span class="badge bg-light text-dark" title="Ref: <%= order.paymentConfirmation %>"><small><%= order.paymentConfirmation.substring(0,15) %>...</small></span><% } else { %> <span class="text-muted">-</span> <% } %></td></tr><% }) %><% } else { %><tr><td colspan="9" class="text-center text-muted py-3">ยังไม่มีคำสั่งซื้อ</td></tr><% } %></tbody></table></div></div></div></div><script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script><script>document.addEventListener('DOMContentLoaded', function() { if(window.location.hash) { const el = document.querySelector(window.location.hash); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('highlight-target'); } } });</script></body></html>
`,
    // --- NAVBAR (Unchanged template) ---
    'navbar.ejs': `
<nav class="navbar navbar-expand-lg navbar-dark bg-dark fixed-top shadow-sm"><div class="container"><a class="navbar-brand" href="/admin"><i class="bi bi-shield-lock"></i> Admin Panel</a><button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNavAdmin" aria-controls="navbarNavAdmin" aria-expanded="false" aria-label="Toggle navigation"><span class="navbar-toggler-icon"></span></button><div class="collapse navbar-collapse" id="navbarNavAdmin"><ul class="navbar-nav ms-auto mb-2 mb-lg-0"><li class="nav-item"><a class="nav-link" href="/admin"><i class="bi bi-speedometer2"></i> แดชบอร์ด</a></li><li class="nav-item"><a class="nav-link" href="/admin/products"><i class="bi bi-box-seam"></i> สินค้า</a></li><li class="nav-item"><a class="nav-link" href="/admin/categories"><i class="bi bi-tags"></i> หมวดหมู่</a></li><li class="nav-item"><a class="nav-link" href="/admin/orders"><i class="bi bi-receipt"></i> คำสั่งซื้อ</a></li><li class="nav-item"><a class="nav-link" href="/admin/codes"><i class="bi bi-key"></i> โค้ดรับของ</a></li></ul></div></div></nav>
`,
    // --- CODES (Unchanged template) ---
    'codes.ejs': `
<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>จัดการโค้ดรับของ - ระบบจัดการร้านค้า</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"><style> body { padding-top: 70px; background-color: #f8f9fa; } .code-list { max-height: 60vh; overflow-y: auto; } .code-item { font-family: monospace; word-break: break-all; } </style></head><body><%- include('navbar') %><div class="container mt-4"> <div class="d-flex justify-content-between align-items-center mb-3"> <h2><i class="bi bi-key-fill"></i> จัดการโค้ดรับของ (<%= codes.length %> โค้ดที่ใช้งานได้)</h2> <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addCodeModal"><i class="bi bi-plus-circle"></i> เพิ่ม/สร้างโค้ด</button> </div> <% if (typeof message !== 'undefined' && message) { %> <div class="alert alert-info alert-dismissible fade show" role="alert"> <i class="bi bi-info-circle-fill"></i> <%= message %> <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button> </div> <% } %> <div class="card shadow-sm"> <div class="card-header bg-light"> รายการโค้ด (32 ตัวอักษร) </div> <div class="card-body"> <% if (codes.length > 0) { %> <div class="code-list border rounded p-3 mb-3"> <ul class="list-group list-group-flush"> <% codes.forEach(code => { %> <li class="list-group-item d-flex justify-content-between align-items-center"> <span class="code-item"><%= code %></span> <form method="POST" action="/admin/codes/delete/<%= code %>" class="ms-2"> <button type="submit" class="btn btn-sm btn-outline-danger" onclick="return confirm('ยืนยันลบโค้ด: <%= code %> ?')" title="ลบโค้ดนี้"> <i class="bi bi-trash3"></i> </button> </form> </li> <% }) %> </ul> </div> <p class="text-muted small">โค้ดที่ถูกใช้งานแล้วจะถูกลบออกจากรายการนี้โดยอัตโนมัติ</p> <% } else { %> <p class="text-center text-muted py-3">ยังไม่มีโค้ดรับของที่ใช้งานได้ในระบบ</p> <% } %> </div> </div></div> <!-- Add Code Modal --> <div class="modal fade" id="addCodeModal" tabindex="-1" aria-labelledby="addCodeModalLabel" aria-hidden="true"> <div class="modal-dialog"> <div class="modal-content"> <form method="POST" action="/admin/codes/add"> <div class="modal-header"> <h5 class="modal-title" id="addCodeModalLabel">เพิ่ม หรือ สร้างโค้ดรับของ</h5> <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button> </div> <div class="modal-body"> <div class="mb-3"> <label for="manualCode" class="form-label">เพิ่มโค้ดด้วยตนเอง (32 ตัวอักษร)</label> <input type="text" name="code" id="manualCode" class="form-control" pattern="[a-zA-Z0-9]{32}" title="ต้องเป็นตัวอักษรภาษาอังกฤษหรือตัวเลข 32 ตัว" placeholder="เว้นว่างเพื่อสร้างอัตโนมัติ"> <div class="form-text">หากระบุโค้ดนี้ ระบบจะไม่สร้างโค้ดให้อัตโนมัติ</div> </div> <hr> <div class="mb-3"> <label for="generateCount" class="form-label">สร้างโค้ดอัตโนมัติ (จำนวน)</label> <input type="number" name="count" id="generateCount" class="form-control" min="1" max="1000" value="10"> <div class="form-text">ระบุจำนวนโค้ดที่ต้องการสร้าง (1-1000) ระบบจะสร้างให้หากช่องด้านบนเว้นว่าง</div> </div> </div> <div class="modal-footer"> <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button> <button type="submit" class="btn btn-primary">เพิ่ม/สร้างโค้ด</button> </div> </form> </div> </div> </div> <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script> <script> document.addEventListener('DOMContentLoaded', function() { const alertElement = document.querySelector('.alert-info'); if(alertElement){ const alert = new bootstrap.Alert(alertElement); setTimeout(() => { alert.close(); }, 7000); } }); </script></body></html>
`
};

Object.entries(templates).forEach(([filename, content]) => {
    const filepath = path.join(viewsDir, filename);
    try {
        fs.mkdirSync(path.dirname(filepath), { recursive: true });
        fs.writeFileSync(filepath, content.trim(), 'utf8');
        console.log(`Admin template '${filename}' created/updated.`);
    } catch (error) { console.error(`Error writing template ${filename}:`, error); }
});
// --- End EJS Setup ---


// --- Server Startup (Unchanged) ---
const PORT = process.env.PORT || (useHttps ? 8443 : 3000);

if (useHttps && credentials.key && credentials.cert) {
    const httpsServer = https.createServer(credentials, app);
    httpsServer.listen(PORT, () => {
        const domain = 'scriptbotonline.vipv2boxth.xyz'; // Use your actual domain
        console.log(`---------------------------------------------------`);
        console.log(`✅ HTTPS Server running on port ${PORT}`);
        console.log(`🔗 Admin Dashboard: https://${domain}/admin`);
        console.log(`🔗 Webhook URL:     https://${domain}/webhook`);
        console.log(`---------------------------------------------------`);
    });
} else {
    app.listen(PORT, () => {
        console.warn(`---------------------------------------------------`);
        console.warn(`⚠️ Running HTTP server on port ${PORT}. HTTPS is highly recommended!`);
        console.warn(`🔗 Admin Dashboard (HTTP): http://localhost:${PORT}/admin`);
        console.warn(`🔗 Webhook URL (HTTP): Needs tunneling (like ngrok) for Facebook.`);
        console.warn(`---------------------------------------------------`);
    });
}

// --- Initial File Creation Checks (Unchanged from previous version) ---
function createInitialFiles() {
    const filesToCreate = {
        'package.json': () => {
            const packageJson = {
                "name": "fb-messenger-shop-v2.1-line-stock", // Updated name
                "version": "2.1.0",
                "description": "FB Messenger Bot shop: Angpao, Xncly Slip, Code Redeem, Line-based Stock",
                "main": path.basename(__filename),
                "scripts": { "start": `node ${path.basename(__filename)}` },
                "dependencies": {
                    "axios": "^1.6.8", "body-parser": "^1.20.2", "ejs": "^3.1.9",
                    "express": "^4.18.2", "form-data": "^4.0.0", "request": "^2.88.2"
                },
                "engines": { "node": ">=16.0.0" }
            };
            return JSON.stringify(packageJson, null, 2);
        },
        'README.md': () => `# Facebook Messenger Digital Shop Bot (v2.1.0 - Line Stock)\n\nA Facebook Messenger bot for selling digital goods with multiple payment/fulfillment options AND line-based stock management.\n\n*   TrueMoney Wallet Angpao (Automatic Redemption)\n*   Bank Transfer (via Xncly Slip Verification API with duplicate slip checking)\n*   Code Redemption (User provides a 32-character code)\n*   **NEW:** Stock Management: Each line in the product's "Download Info" field in the admin panel represents one unique stock item (code, link, etc.). Purchasing consumes one line.\n*   Admin Dashboard for managing products, categories, orders, and redemption codes.\n\n## Setup\n\n1.  **Install Dependencies:** \`npm install\`\n2.  **Configuration:** Edit the script (\`${path.basename(__filename)}\`) for \`CONFIG\`, \`VERIFY_TOKEN\`, \`PAGE_ACCESS_TOKEN\`, SSL paths, and Xncly details.\n3.  **Admin Panel:**\n    *   Add Products: Use the "Download Info" textarea. Enter *one code/link per line*. Each line counts as one stock item.\n    *   Add Redemption Codes (for the separate redeem feature) via \`/admin/codes\`.\n4.  **Facebook App Setup:** Set up Messenger platform, Webhook (\`https://your_domain/webhook\`), and Page Access Token.\n5.  **Run:** \`npm start\` or \`node ${path.basename(__filename)}\`\n\n## Key Changes in v2.1\n\n*   Removed the numerical 'Stock' field for products.\n*   Stock is now determined by the number of non-empty lines in the 'Download Info' field.\n*   When a product is purchased, the bot takes the *first* line from 'Download Info', delivers it to the user, and removes it from the product data.\n*   Cart logic simplified: Adding an item adds one instance to the cart.\n*   Checkout verifies stock based on the number of times a product appears in the cart vs. the available lines.`,
        '.gitignore': () => `node_modules\n*.log\nshop_data.json\nverified_slips.json\nredemption_codes.json\n*.pem\n*.env\n.DS_Store`
    };
    Object.entries(filesToCreate).forEach(([filename, contentFn]) => {
        const filepath = path.join(__dirname, filename);
        if (!fs.existsSync(filepath)) {
            try {
                fs.writeFileSync(filepath, contentFn().trim(), 'utf8');
                console.log(`Created initial file: ${filename}`);
                if (filename === 'package.json') console.log("--> Run 'npm install' <--");
            } catch (error) { console.error(`Error creating ${filename}:`, error); }
        }
    });
    if (!fs.existsSync(DATA_FILE)) saveShopData();
    if (!fs.existsSync(VERIFIED_SLIPS_FILE)) saveVerifiedSlips();
    if (!fs.existsSync(REDEMPTION_CODES_FILE)) saveValidRedemptionCodes();
}
createInitialFiles(); 
