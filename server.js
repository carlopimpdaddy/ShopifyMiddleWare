require('dotenv').config()

const express = require('express')
const axios = require('axios')
const { createClient } = require('@supabase/supabase-js')

const app = express()
const PORT = process.env.PORT || 8080

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY
const supabase = createClient(supabaseUrl, supabaseKey)

app.use(express.json())

app.post('/user-registration', async (req, res) => {
    console.log('Received /user-registration:', req.body)

    try {
        const customerData = req.body
        const customerId = customerData.id
        console.log('New user registration with ID:', customerId)

        const { error } = await supabase.from('users').insert([
            {
                id: customerData.id,
                email: customerData.email,
                created_at: customerData.created_at,
                updated_at: customerData.updated_at,
                first_name: customerData.first_name,
                last_name: customerData.last_name,
                orders_count: customerData.orders_count,
                state: customerData.state,
                total_spent: customerData.total_spent,
                last_order_id: customerData.last_order_id,
                note: customerData.note,
                verified_email: customerData.verified_email,
                multipass_identifier: customerData.multipass_identifier,
                tags: customerData.tags,
                last_order_name: customerData.last_order_name,
                currency: customerData.currency,
                phone: customerData.phone,
            },
        ])

        if (error) throw error

        res.status(200).send('Webhook received and processed')
    } catch (error) {
        console.error('Error processing webhook:', error.message)
        res.status(500).send('Webhook Error')
    }
})

// Shopify API configuration
const shopifyConfig = {
    storeUrl: process.env.STORE_URL,
    accessToken: process.env.ACCESS_TOKEN,
}

app.use(express.json())

// Function to fetch product metadata from Shopify
async function fetchProductMetadata(productId) {
    try {
        const response = await axios.get(
            `${shopifyConfig.storeUrl}/admin/api/2023-10/products/${productId}.json`,
            {
                headers: {
                    'X-Shopify-Access-Token': shopifyConfig.accessToken,
                },
            }
        )
        return response.data.product // Returns product details, including metadata
    } catch (error) {
        console.error(
            `Error fetching metadata for product ID ${productId}:`,
            error.message
        )
        return null
    }
}

app.post('/shopify-order-webhook', async (req, res) => {
    const orderData = req.body

    // Extract main information for the orders table
    const orderId = orderData.id
    const customerId = orderData.customer ? orderData.customer.id : null
    const customerEmail = orderData.customer ? orderData.customer.email : null
    const purchaseDate = orderData.created_at
    const totalAmount = orderData.current_total_price
    const currency = orderData.currency

    // Array to store line items with metadata
    const lineItemsWithMetadata = []

    // Process line items, fetching metadata for each product
    for (const item of orderData.line_items) {
        const productId = item.product_id

        // Fetch product metadata
        const productData = await fetchProductMetadata(productId)
        const metadata = productData ? productData.metafields : null
        console.log(productData)
        // Log metadata for debugging
        console.log(
            `Metadata for product ${item.name} (ID: ${productId}):`,
            metadata
        )

        // Add the line item to the array with additional metadata
        lineItemsWithMetadata.push({
            productName: item.name,
            sku: parseInt(item.sku),
            quantity: parseInt(item.quantity),
            price: parseFloat(item.price),
            fulfillmentStatus: item.fulfillment_status,
            // metadata: metadata,
        })
    }

    try {
        // Step 1: Insert order into the orders table
        const { data: orderLogData, error: orderLogError } = await supabase
            .from('orders')
            .insert([
                {
                    id: orderId,
                    customer_id: customerId,
                    customer_email: customerEmail,
                    purchase_date: purchaseDate,
                    total_amount: totalAmount,
                    currency: currency,
                    line_items: lineItemsWithMetadata, // Save line items with metadata as JSONB
                },
            ])

        if (orderLogError) {
            console.error(
                'Error logging order to orders table:',
                orderLogError.message
            )
            return res.status(500).send('Error processing webhook')
        }

        console.log('Order logged in orders table:', orderLogData)

        // Step 2: Accumulate sku_quantity in the user_sku_quantities table
        for (const item of lineItemsWithMetadata) {
            const skuQuantity = item.sku // Use the numeric SKU quantity

            // Check if there is already a record for this user
            const { data: existingData, error: existingError } = await supabase
                .from('user_sku_quantities')
                .select('*')
                .eq('user_id', customerId)
                .single()

            if (existingError && existingError.code !== 'PGRST116') {
                console.error(
                    'Error checking for existing record:',
                    existingError.message
                )
                throw new Error('Database query error')
            }

            if (existingData) {
                // Update existing record by adding new SKU quantity
                const newSkuQuantity = existingData.sku_quantity + skuQuantity
                await supabase
                    .from('user_sku_quantities')
                    .update({
                        sku_quantity: newSkuQuantity,
                        last_purchase_date: purchaseDate,
                    })
                    .eq('user_id', customerId)
            } else {
                // Create a new record
                await supabase.from('user_sku_quantities').insert({
                    user_id: customerId,
                    sku_quantity: skuQuantity,
                    last_purchase_date: purchaseDate,
                })
            }
        }

        console.log(`Order processed for customer ID: ${customerId}`)
        res.status(200).send('Order webhook received and processed')
    } catch (error) {
        console.error('Error processing order:', error.message)
        res.status(500).send('Error processing order')
    }
})

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`)
})
