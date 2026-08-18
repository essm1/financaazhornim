import express from "express";
import axios from "axios";
import fs from "fs";
import cron from "node-cron";
import dotenv from "dotenv";

dotenv.config();

/* =========================================================
   CONFIGURATION
========================================================= */

const app = express();

const PORT = process.env.PORT || 4000;

const SHOP = process.env.SHOP;
const TOKEN = process.env.SHOPIFY_TOKEN;
const LOCATION_ID = process.env.LOCATION_ID;
const FINANCA_API = process.env.FINANCA_API;

const SHOPIFY_API_VERSION = "2026-01";

/*
   Free Render:
   Mos vendos batch shumë të madh.
*/
const BATCH_SIZE = 50;

/*
   Sa herë provojmë një request që dështon.
*/
const MAX_RETRIES = 3;

/*
   Koha mes retry-ve.
*/
const RETRY_DELAY = 2000;

/*
   Koha mes produkteve.
   Kjo ndihmon me rate limits.
*/
const PRODUCT_DELAY = 300;

/*
   State file.
*/
const STATE_FILE = "./state.json";


/* =========================================================
   STATE
========================================================= */

let state = {
    status: "idle",

    total: 0,

    processed: 0,

    updated: 0,

    skipped: 0,

    errors: 0,

    currentIndex: 0,

    currentSKU: null,

    lastProcessedSKU: null,

    startedAt: null,

    lastUpdate: null,

    lastError: null,

    cycle: 1,

    productsLoadedAt: null
};


/* =========================================================
   LOAD STATE
========================================================= */

function loadState() {

    try {

        if (fs.existsSync(STATE_FILE)) {

            const data =
                fs.readFileSync(
                    STATE_FILE,
                    "utf8"
                );

            const saved =
                JSON.parse(data);

            state = {
                ...state,
                ...saved
            };

            console.log("STATE LOADED");
            console.log(state);

        } else {

            saveState();

        }

    } catch (error) {

        console.log(
            "STATE LOAD ERROR:",
            error.message
        );

    }

}


/* =========================================================
   SAVE STATE
========================================================= */

function saveState() {

    try {

        fs.writeFileSync(
            STATE_FILE,
            JSON.stringify(
                state,
                null,
                2
            )
        );

    } catch (error) {

        console.log(
            "STATE SAVE ERROR:",
            error.message
        );

    }

}


/* =========================================================
   BASIC VALIDATION
========================================================= */

function validateConfig() {

    const missing = [];

    if (!SHOP) {
        missing.push("SHOP");
    }

    if (!TOKEN) {
        missing.push("SHOPIFY_TOKEN");
    }

    if (!LOCATION_ID) {
        missing.push("LOCATION_ID");
    }

    if (!FINANCA_API) {
        missing.push("FINANCA_API");
    }

    if (missing.length) {

        console.log(
            "MUNGON ENV:",
            missing.join(", ")
        );

        return false;

    }

    return true;

}


/* =========================================================
   UTILS
========================================================= */

function sleep(ms) {

    return new Promise(
        resolve => setTimeout(resolve, ms)
    );

}


function formatPrice(value) {

    if (
        value === null ||
        value === undefined
    ) {

        return "0.00";

    }

    let price =
        String(value)
            .trim();

    price =
        price.replace(/\s/g, "");

    /*
       1.680,50
       ->
       1680.50
    */

    if (
        price.includes(",") &&
        price.includes(".")
    ) {

        price =
            price
                .replace(/\./g, "")
                .replace(",", ".");

    }

    /*
       1680,50
       ->
       1680.50
    */

    else if (
        price.includes(",")
    ) {

        price =
            price.replace(",", ".");

    }

    const number =
        parseFloat(price);

    if (isNaN(number)) {

        return "0.00";

    }

    return number.toFixed(2);

}


function parseStock(value) {

    const number =
        Number(value);

    if (
        !Number.isFinite(number)
    ) {

        return 0;

    }

    return Math.max(
        0,
        Math.floor(number)
    );

}


/* =========================================================
   RETRY SYSTEM
========================================================= */

async function withRetry(
    fn,
    name = "REQUEST"
) {

    let lastError = null;

    for (
        let attempt = 1;
        attempt <= MAX_RETRIES;
        attempt++
    ) {

        try {

            return await fn();

        } catch (error) {

            lastError = error;

            console.log(
                `${name} FAILED - ATTEMPT ${attempt}/${MAX_RETRIES}`,
                error.message
            );

            if (
                attempt < MAX_RETRIES
            ) {

                await sleep(
                    RETRY_DELAY * attempt
                );

            }

        }

    }

    throw lastError;

}


/* =========================================================
   SHOPIFY GRAPHQL
========================================================= */

async function shopify(query, variables = {}) {

    return await withRetry(
        async () => {

            const response =
                await axios.post(

                    `https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,

                    {
                        query,
                        variables
                    },

                    {
                        headers: {

                            "Content-Type":
                                "application/json",

                            "X-Shopify-Access-Token":
                                TOKEN

                        },

                        timeout: 30000

                    }

                );


            if (
                response.data?.errors &&
                response.data.errors.length
            ) {

                throw new Error(
                    JSON.stringify(
                        response.data.errors
                    )
                );

            }


            return response.data;

        },

        "SHOPIFY"

    );

}


/* =========================================================
   FINANCA API
========================================================= */

async function loadFinanca() {

    console.log(
        "================================"
    );

    console.log(
        "LOADING FINANCA"
    );

    console.log(
        "================================"
    );


    const response =
        await withRetry(

            async () => {

                const result =
                    await axios.get(
                        FINANCA_API,
                        {
                            timeout: 30000
                        }
                    );

                if (
                    result.status !== 200
                ) {

                    throw new Error(
                        `Financa HTTP ${result.status}`
                    );

                }

                return result;

            },

            "FINANCA API"

        );


    const data =
        response.data;


    if (!data?.success) {

        throw new Error(
            "Financa API returned success=false"
        );

    }


    const products =
        data?.data?.data;


    if (
        !Array.isArray(products)
    ) {

        throw new Error(
            "Financa products nuk eshte array"
        );

    }


    console.log(
        "FINANCA PRODUCTS:",
        products.length
    );


    state.total =
        products.length;

    state.productsLoadedAt =
        new Date().toISOString();

    saveState();


    return products;

}


/* =========================================================
   GET SHOPIFY VARIANTS
========================================================= */

/*
   Kjo funksion merr variantet nga Shopify
   dhe krijon nje MAP:

   SKU -> variant information
*/

async function loadShopifyVariants() {

    console.log(
        "================================"
    );

    console.log(
        "LOADING SHOPIFY VARIANTS"
    );

    console.log(
        "================================"
    );


    const map = new Map();

    let hasNextPage = true;

    let cursor = null;

    let pages = 0;


    while (hasNextPage) {

        pages++;


        const query = `

            query GetVariants(
                $cursor: String
            ) {

                productVariants(
                    first: 100
                    after: $cursor
                ) {

                    pageInfo {

                        hasNextPage

                        endCursor

                    }

                    edges {

                        node {

                            id

                            sku

                            price

                            inventoryItem {

                                id

                            }

                            product {

                                id

                            }

                        }

                    }

                }

            }

        `;


        const result =
            await shopify(
                query,
                {
                    cursor
                }
            );


        const variants =
            result
                ?.data
                ?.productVariants;


        if (!variants) {

            throw new Error(
                "Shopify variants nuk u kthyen"
            );

        }


        for (
            const edge of
            variants.edges || []
        ) {

            const variant =
                edge.node;


            if (
                variant.sku
            ) {

                const sku =
                    String(
                        variant.sku
                    )
                        .trim();


                map.set(
                    sku,
                    variant
                );

            }

        }


        hasNextPage =
            variants.pageInfo.hasNextPage;


        cursor =
            variants.pageInfo.endCursor;


        console.log(
            `Shopify variants page ${pages} - MAP ${map.size}`
        );


        /*
           Pushim i vogël.
        */

        await sleep(300);

    }


    console.log(
        "SHOPIFY SKU MAP:",
        map.size
    );


    return map;

}


/* =========================================================
   UPDATE PRICE
========================================================= */

async function updatePrice(
    productId,
    variantId,
    price
) {

    const mutation = `

        mutation UpdatePrice(
            $productId: ID!
            $variants: [ProductVariantsBulkInput!]!
        ) {

            productVariantsBulkUpdate(

                productId: $productId

                variants: $variants

            ) {

                productVariants {

                    id

                    price

                }

                userErrors {

                    field

                    message

                }

            }

        }

    `;


    const result =
        await shopify(
            mutation,
            {

                productId,

                variants: [

                    {

                        id: variantId,

                        price

                    }

                ]

            }
        );


    const errors =
        result
            ?.data
            ?.productVariantsBulkUpdate
            ?.userErrors || [];


    if (errors.length) {

        throw new Error(
            JSON.stringify(errors)
        );

    }


    return true;

}


/* =========================================================
   UPDATE STOCK
========================================================= */

async function updateInventory(
    inventoryItemId,
    quantity
) {

    const mutation = `

        mutation SetInventory(
            $input: InventorySetQuantitiesInput!
        ) {

            inventorySetQuantities(

                input: $input

            ) {

                userErrors {

                    field

                    message

                }

            }

        }

    `;


    const input = {

        name: "available",

        reason: "correction",

        ignoreCompareQuantity: true,

        quantities: [

            {

                inventoryItemId,

                locationId:
                    `gid://shopify/Location/${LOCATION_ID}`,

                quantity

            }

        ]

    };


    const result =
        await shopify(
            mutation,
            {
                input
            }
        );


    const errors =
        result
            ?.data
            ?.inventorySetQuantities
            ?.userErrors || [];


    if (errors.length) {

        throw new Error(
            JSON.stringify(errors)
        );

    }


    return true;

}


/* =========================================================
   PROCESS ONE PRODUCT
========================================================= */

async function processProduct(
    item,
    shopifyMap
) {

    const sku =
        String(
            item.Barkod ?? ""
        )
            .trim();


    if (!sku) {

        throw new Error(
            "Produkt pa SKU/Barkod"
        );

    }


    const price =
        formatPrice(
            item.Cmimi
        );


    const stock =
        parseStock(
            item.Sasi
        );


    state.currentSKU =
        sku;

    saveState();


    const variant =
        shopifyMap.get(sku);


    /*
       Nuk ekziston në Shopify.
    */

    if (!variant) {

        console.log(
            "NUK U GJET:",
            sku
        );

        state.skipped++;

        return {

            status: "skipped",

            sku

        };

    }


    let changed = false;


    /*
       PRICE
    */

    const currentPrice =
        formatPrice(
            variant.price
        );


    if (
        currentPrice !== price
    ) {

        console.log(
            `PRICE CHANGE ${sku}: ${currentPrice} -> ${price}`
        );


        await updatePrice(

            variant.product.id,

            variant.id,

            price

        );


        changed = true;

    }


    /*
       STOCK
    */

    await updateInventory(

        variant.inventoryItem.id,

        stock

    );


    /*
       STOCK update u bë.
    */

    changed = true;


    if (changed) {

        state.updated++;

    }


    console.log(
        `SYNC OK | SKU ${sku} | PRICE ${price} | STOCK ${stock}`
    );


    return {

        status: "updated",

        sku

    };

}


/* =========================================================
   SYNC BATCH
========================================================= */

let running = false;


async function syncBatch() {

    if (running) {

        console.log(
            "SYNC ALREADY RUNNING"
        );

        return;

    }


    if (
        !validateConfig()
    ) {

        return;

    }


    running = true;

    state.status =
        "running";

    state.startedAt =
        new Date().toISOString();

    state.lastError =
        null;

    saveState();


    try {

        /*
           1. Merr Financa.
        */

        const financaProducts =
            await loadFinanca();


        /*
           Nëse kemi kaluar fundin,
           fillojmë cycle të ri.
        */

        if (
            state.currentIndex >=
            financaProducts.length
        ) {

            state.currentIndex = 0;

            state.processed = 0;

            state.updated = 0;

            state.skipped = 0;

            state.errors = 0;

            state.cycle++;

            saveState();

        }


        /*
           2. Merr Shopify SKU MAP.
        */

        const shopifyMap =
            await loadShopifyVariants();


        /*
           3. Llogarit batch.
        */

        const start =
            state.currentIndex;


        const end =
            Math.min(

                start + BATCH_SIZE,

                financaProducts.length

            );


        console.log(
            `PROCESSING ${start + 1} -> ${end} / ${financaProducts.length}`
        );


        /*
           4. Përpuno produktet.
        */

        for (
            let i = start;
            i < end;
            i++
        ) {

            const item =
                financaProducts[i];


            try {

                await processProduct(
                    item,
                    shopifyMap
                );


            } catch (error) {

                state.errors++;

                state.lastError =
                    `${item?.Barkod || "UNKNOWN"}: ${error.message}`;


                console.log(
                    "PRODUCT ERROR:",
                    item?.Barkod,
                    error.message
                );

            }


            /*
               Ky produkt konsiderohet
               processed edhe nëse pati error.
            */

            state.processed++;

            state.currentIndex =
                i + 1;

            state.lastProcessedSKU =
                String(
                    item?.Barkod ?? ""
                ).trim();


            state.lastUpdate =
                new Date().toISOString();


            saveState();


            /*
               Mos e godasim Shopify-n
               pa pushim.
            */

            await sleep(
                PRODUCT_DELAY
            );

        }


        /*
           5. Kontrollo nëse mbaroi cycle.
        */

        if (
            state.currentIndex >=
            financaProducts.length
        ) {

            console.log(
                "================================"
            );

            console.log(
                "SYNC CYCLE FINISHED"
            );

            console.log(
                "================================"
            );


            state.status =
                "completed";


            state.lastUpdate =
                new Date().toISOString();


            saveState();

        } else {

            state.status =
                "paused";


            saveState();

        }


    } catch (error) {

        console.log(
            "SYNC ERROR:",
            error.message
        );


        state.status =
            "error";


        state.lastError =
            error.message;


        state.lastUpdate =
            new Date().toISOString();


        saveState();

    } finally {

        running = false;

    }

}


/* =========================================================
   STATUS PAGE
========================================================= */

app.get(
    "/",
    (req, res) => {

        res.send(
            "Financa Sync V2 Active"
        );

    }
);


app.get(
    "/status",
    (req, res) => {

        const percentage =
            state.total > 0

                ? (
                    state.currentIndex /
                    state.total *
                    100
                ).toFixed(2)

                : "0.00";


        res.json({

            system:
                "Financa Sync V2",

            running,

            status:
                state.status,

            total:
                state.total,

            processed:
                state.processed,

            updated:
                state.updated,

            skipped:
                state.skipped,

            errors:
                state.errors,

            currentIndex:
                state.currentIndex,

            currentSKU:
                state.currentSKU,

            lastProcessedSKU:
                state.lastProcessedSKU,

            progress:
                `${percentage}%`,

            cycle:
                state.cycle,

            startedAt:
                state.startedAt,

            lastUpdate:
                state.lastUpdate,

            lastError:
                state.lastError

        });

    }
);


/* =========================================================
   MANUAL SYNC ENDPOINT
========================================================= */

app.get(
    "/sync",
    async (req, res) => {

        if (running) {

            return res.json({

                success: false,

                message:
                    "Sync is already running."

            });

        }


        syncBatch();


        res.json({

            success: true,

            message:
                "Sync batch started."

        });

    }
);


/* =========================================================
   RESET
========================================================= */

app.get(
    "/reset",
    (req, res) => {

        state = {

            status: "idle",

            total: 0,

            processed: 0,

            updated: 0,

            skipped: 0,

            errors: 0,

            currentIndex: 0,

            currentSKU: null,

            lastProcessedSKU: null,

            startedAt: null,

            lastUpdate: null,

            lastError: null,

            cycle: 1,

            productsLoadedAt: null

        };


        saveState();


        res.json({

            success: true,

            message:
                "State reset."

        });

    }
);


/* =========================================================
   SERVER
========================================================= */

app.listen(
    PORT,
    () => {

        console.log(
            "================================"
        );

        console.log(
            "FINANCA SYNC V2"
        );

        console.log(
            "================================"
        );

        console.log(
            `Server running on port ${PORT}`
        );

    }
);


/* =========================================================
   INITIALIZE
========================================================= */

loadState();


/* =========================================================
   AUTOMATIC CRON
========================================================= */

/*
   Çdo 5 minuta.

   Jo çdo minutë si projekti i vjetër.
*/

cron.schedule(
    "*/5 * * * *",
    async () => {

        console.log(
            "================================"
        );

        console.log(
            "AUTOMATIC SYNC"
        );

        console.log(
            new Date().toISOString()
        );

        console.log(
            "================================"
        );


        try {

            await syncBatch();

        } catch (error) {

            console.log(
                "CRON ERROR:",
                error.message
            );

        }

    }
);


/* =========================================================
   START FIRST SYNC
========================================================= */

/*
   Nuk e nisim menjëherë automatikisht
   sapo Render bëhet deploy.

   Kjo është e qëllimshme për testin e parë.
*/

console.log(
    "Financa Sync V2 ready."
);

console.log(
    "Automatic sync: every 5 minutes."
);

console.log(
    "Manual test: /sync"
);
