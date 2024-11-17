require('dotenv').config()

const express = require('express')
const axios = require('axios')
const cors = require('cors')
const { createClient } = require('@supabase/supabase-js')

const app = express()
const PORT = process.env.PORT || 8080

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY
const supabase = createClient(supabaseUrl, supabaseKey)

app.use(express.json())
// Apply CORS middleware to allow all origins (for testing purposes)
app.use(cors())

app.post('/user-registration', async (req, res) => {
    console.log('Received /user-registration:', req.body)

    try {
        const customerData = req.body
        console.log('New user registration with ID:', customerData)

        const { error } = await supabase.from('users').insert([
            {
                id: customerData.id,
                email: customerData.email,
                created_at: customerData.created_at,
                updated_at: customerData.updated_at,
                orders_count: customerData.orders_count,
                total_spent: customerData.total_spent,
                verified_email: customerData.verified_email,
                currency: customerData.currency,
                phone: customerData.phone,
            },
        ])

        if (error) throw error

        res.status(200).send('Webhook received and   processed')
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

        for (const item of lineItemsWithMetadata) {
            const skuQuantity = item.sku // Use the numeric SKU quantity
            console.log('Processing line item:', item)

            try {
                // Check if a record exists for this user
                const { data: existingData, error: existingError } =
                    await supabase
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
                    // Update existing record
                    const newSkuQuantity =
                        existingData.sku_quantity + skuQuantity
                    const { error } = await supabase
                        .from('user_sku_quantities')
                        .update({
                            sku_quantity: newSkuQuantity,
                            last_purchase_date: purchaseDate,
                        })
                        .eq('user_id', customerId)

                    if (error) throw error

                    console.log(
                        'Updated user_sku_quantities for user_id:',
                        customerId
                    )
                } else {
                    // Insert new record
                    const { error } = await supabase
                        .from('user_sku_quantities')
                        .insert({
                            user_id: customerId,
                            sku_quantity: skuQuantity,
                            last_purchase_date: purchaseDate,
                        })
                    if (error) throw error

                    console.log('Inserted into user_sku_quantities:', {
                        user_id: customerId,
                        sku_quantity: skuQuantity,
                        last_purchase_date: purchaseDate,
                    })
                }
            } catch (error) {
                console.error('Error in step 2:', error.message)
            }
        }

        console.log(`Order processed for customer ID: ${customerId}`)
        res.status(200).send('Order webhook received and processed')
    } catch (error) {
        console.error('Error processing order:', error.message)
        res.status(500).send('Error processing order')
    }
})

app.post('/count', async (req, res) => {
    const { requestCount, userId, botId } = req.body // Extract the counter, userId, and botId from the request body
    console.log(requestCount, userId, botId)

    if (!requestCount || !userId || !botId) {
        // If any required data is missing, respond with an error
        return res
            .status(400)
            .json({ error: 'Missing request count, user ID, or bot ID' })
    }

    try {
        console.log(`Received request count: ${requestCount}`)
        console.log(`User ID: ${userId}, Bot ID: ${botId}`)

        // Find records in `user_sku_quantities` matching both user_id and bot_id
        const { data, error } = await supabase
            .from('user_sku_quantities')
            .select('*')
            .eq('user_id', userId)
            .eq('bot_id', botId)

        if (error) {
            console.error('Error fetching records:', error.message)
            return res.status(500).json({ error: 'Error fetching records' })
        }

        if (data && data.length > 0) {
            // Loop through each record and decrement sku_quantity only if it's greater than 0
            const updates = data.map(async (record) => {
                if (record.sku_quantity > 0) {
                    const newSkuQuantity = record.sku_quantity - 1
                    const updateResponse = await supabase
                        .from('user_sku_quantities')
                        .update({ sku_quantity: newSkuQuantity })
                        .eq('id', record.id) // Use record ID to update the correct row

                    if (updateResponse.error) {
                        console.error(
                            `Error updating record ID ${record.id}:`,
                            updateResponse.error.message
                        )
                    } else {
                        console.log(
                            `Decremented sku_quantity for record ID ${record.id} to ${newSkuQuantity}`
                        )
                    }
                } else {
                    console.log(
                        `Record ID ${record.id} has sku_quantity 0, no decrement applied`
                    )
                }
            })

            // Wait for all updates to complete
            await Promise.all(updates)

            // Respond to the client
            res.status(200).json({
                message: 'SKU quantities decremented where possible',
                requestCount,
            })
        } else {
            console.log(
                `No records found for user ID: ${userId} and bot ID: ${botId}`
            )
            res.status(404).json({
                error: 'No records found for this user ID and bot ID',
            })
        }
    } catch (error) {
        console.error('Error processing request:', error.message)
        res.status(500).json({ error: 'Error processing request' })
    }
})

app.post('/save-user-bot-id', async (req, res) => {
    const { customerId, botId } = req.body
    console.log(customerId, botId)

    try {
        // Check if a record already exists for this user_id
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
            // Update the existing record with the bot_id
            const { error } = await supabase
                .from('user_sku_quantities')
                .update({ bot_id: botId })
                .eq('user_id', customerId)

            if (error) throw error
            console.log('Updated bot_id for existing user:', customerId)
        } else {
            // Insert a new record with both customerId and botId
            const { error } = await supabase
                .from('user_sku_quantities')
                .insert({
                    user_id: customerId,
                    bot_id: botId,
                })

            if (error) throw error
            console.log('Inserted new record with user_id and bot_id')
        }

        res.status(200).send('User ID and Bot ID saved')
    } catch (error) {
        console.error('Error saving User ID and Bot ID:', error.message)
        res.status(500).send('Error saving User ID and Bot ID')
    }
})

app.post('/check-sku-quantity', async (req, res) => {
    const { customerId } = req.body
    console.log(customerId)
    try {
        // Query Supabase for user data with the specified customer ID
        const { data, error } = await supabase
            .from('user_sku_quantities')
            .select('*')
            .eq('user_id', customerId)
            .single()

        if (error) {
            console.error('Error querying Supabase:', error.message)
            return res.status(500).json({ error: 'Error querying Supabase' })
        }

        // Prepare the response with detailed user data for the "admin panel" view
        const response = {
            showButton:
                data && (data.sku_quantity > 0 || data.sku_quantity == null),
            userData: {
                userId: data.user_id,
                skuQuantity: data.sku_quantity,
                lastPurchaseDate: data.last_purchase_date,
                botId: data.bot_id,
            },
        }

        res.json(response)
    } catch (error) {
        console.error('Error checking SKU quantity:', error.message)
        res.status(500).json({ error: 'Error checking SKU quantity' })
    }
})

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`)
})
