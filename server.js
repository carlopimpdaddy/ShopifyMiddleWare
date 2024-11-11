// server.js
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.post('/user-registration', async (req, res) => {
    console.log('We have/user-registration:', req.body);
  
    try {
      const customerData = req.body;
      const customerId = customerData.id;
      console.log('We have new ', customerId);
  
      res.status(200).send('Webhook received and processed');
    } catch (error) {
      console.error('Error:', error);
      res.status(500).send('Webhook Error');
    }
  });

  app.post('/shopify-order-webhook', (req, res) => {
    const orderData = req.body;
    const orderId = orderData.id;
    const customerId = orderData.customer ? orderData.customer.id : null;
    console.log(orderData,'We have new order:', orderId, 'for user:', customerId);
  
    res.status(200).send('Order webhook received and processed');
  });
  

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
