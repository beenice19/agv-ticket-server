require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

const PORT = 8793;

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

const APP_BASE_URL = process.env.AGV_APP_BASE_URL || "http://127.0.0.1:5175";
const SUBSCRIPTION_API_BASE =
  process.env.AGV_SUBSCRIPTION_API_BASE || "http://127.0.0.1:8792";

const STRIPE_CREATOR_PRICE_ID = process.env.STRIPE_CREATOR_PRICE_ID || "";
const STRIPE_MINISTRY_PRICE_ID = process.env.STRIPE_MINISTRY_PRICE_ID || "";
const STRIPE_CONVENTION_PRICE_ID = process.env.STRIPE_CONVENTION_PRICE_ID || "";
const STRIPE_INTERNAL_TEST_PRICE_ID =
  process.env.STRIPE_INTERNAL_TEST_PRICE_ID || "";

const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;

const app = express();

app.use(cors({ origin: true, credentials: true }));

const PLANS = {
  INTERNAL_TEST: {
    name: "AGV Internal Test",
    price: "$1/month",
    priceId: STRIPE_INTERNAL_TEST_PRICE_ID,
    activatesPlan: "CREATOR",
  },
  CREATOR: {
    name: "AGV Creator",
    price: "$29/month",
    priceId: STRIPE_CREATOR_PRICE_ID,
    activatesPlan: "CREATOR",
  },
  MINISTRY: {
    name: "AGV Ministry / Pro",
    price: "$99/month",
    priceId: STRIPE_MINISTRY_PRICE_ID,
    activatesPlan: "MINISTRY",
  },
  CONVENTION: {
    name: "AGV Convention",
    price: "$299/month",
    priceId: STRIPE_CONVENTION_PRICE_ID,
    activatesPlan: "CONVENTION",
  },
};

function cleanText(value) {
  return String(value || "").trim();
}

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

async function findCustomerByEmail(email) {
  const customerEmail = cleanEmail(email);

  if (!customerEmail || !stripe) {
    return null;
  }

  const customers = await stripe.customers.list({
    email: customerEmail,
    limit: 1,
  });

  return customers.data?.[0] || null;
}

app.post(
  "/api/billing/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe) {
      return res.status(400).send("Stripe is not configured.");
    }

    if (!STRIPE_WEBHOOK_SECRET) {
      return res.status(400).send("Stripe webhook secret is not configured.");
    }

    const signature = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.error("WEBHOOK SIGNATURE FAILED:", error.message);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        const checkoutPlan = String(session?.metadata?.agvPlan || "").toUpperCase();
        const selectedPlan = PLANS[checkoutPlan];

        if (selectedPlan) {
          const planToActivate = selectedPlan.activatesPlan || checkoutPlan;

          const updateResponse = await fetch(
            `${SUBSCRIPTION_API_BASE}/api/subscription/plan`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ plan: planToActivate }),
            }
          );

          const updateData = await updateResponse.json();

          if (!updateResponse.ok || !updateData?.ok) {
            console.error("AGV PLAN UPDATE FAILED:", updateData);
          } else {
            console.log("AGV PLAN ACTIVATED:", planToActivate);
            console.log("STRIPE CHECKOUT PLAN:", checkoutPlan);
          }
        } else {
          console.log("Stripe checkout completed, but AGV plan was missing or invalid.");
        }
      }

      return res.json({ received: true });
    } catch (error) {
      console.error("WEBHOOK HANDLER FAILED:", error.message);
      return res.status(500).send("Webhook handler failed.");
    }
  }
);

app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AGV Stripe Billing Server",
    port: PORT,
    stripeConfigured: Boolean(stripe),
    webhookConfigured: Boolean(STRIPE_WEBHOOK_SECRET),
    billingPortalRoute: true,
    appBaseUrl: APP_BASE_URL,
    subscriptionApiBase: SUBSCRIPTION_API_BASE,
    plans: {
      internalTest: Boolean(STRIPE_INTERNAL_TEST_PRICE_ID),
      creator: Boolean(STRIPE_CREATOR_PRICE_ID),
      ministry: Boolean(STRIPE_MINISTRY_PRICE_ID),
      convention: Boolean(STRIPE_CONVENTION_PRICE_ID),
    },
  });
});

app.get("/api/billing/plans", (req, res) => {
  res.json({
    ok: true,
    plans: PLANS,
  });
});

app.post("/api/billing/create-checkout-session", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(400).json({
        ok: false,
        error: "Stripe secret key is not configured yet.",
      });
    }

    const plan = String(req.body.plan || "").trim().toUpperCase();
    const customerEmail = cleanEmail(req.body.customerEmail || req.body.email);
    const selectedPlan = PLANS[plan];

    if (!selectedPlan) {
      return res.status(400).json({
        ok: false,
        error: "Invalid plan.",
        allowedPlans: Object.keys(PLANS),
      });
    }

    if (!selectedPlan.priceId) {
      return res.status(400).json({
        ok: false,
        error: `Stripe price ID is missing for ${plan}.`,
      });
    }

    const sessionConfig = {
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: selectedPlan.priceId,
          quantity: 1,
        },
      ],
      success_url: `${APP_BASE_URL}?billing=success&plan=${plan}`,
      cancel_url: `${APP_BASE_URL}?billing=cancelled`,
      metadata: {
        agvPlan: plan,
        agvProduct: selectedPlan.name,
        activatesPlan: selectedPlan.activatesPlan || plan,
      },
    };

    if (customerEmail) {
      sessionConfig.customer_email = customerEmail;
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);

    res.json({
      ok: true,
      plan,
      checkoutUrl: session.url,
      sessionId: session.id,
      customerId: session.customer || "",
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || "Stripe checkout failed.",
    });
  }
});

app.post("/api/billing/create-portal-session", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(400).json({
        ok: false,
        error: "Stripe secret key is not configured yet.",
      });
    }

    const customerId = cleanText(req.body.customerId);
    const customerEmail = cleanEmail(req.body.customerEmail || req.body.email);

    let customer = null;

    if (customerId) {
      customer = await stripe.customers.retrieve(customerId);

      if (customer?.deleted) {
        return res.status(404).json({
          ok: false,
          error: "Stripe customer was deleted.",
        });
      }
    } else if (customerEmail) {
      customer = await findCustomerByEmail(customerEmail);
    }

    if (!customer?.id) {
      return res.status(404).json({
        ok: false,
        error:
          "Stripe customer not found. Complete checkout first, then open the billing portal.",
      });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: `${APP_BASE_URL}?billing=portal-return`,
    });

    res.json({
      ok: true,
      portalUrl: portalSession.url,
      customerId: customer.id,
      returnUrl: `${APP_BASE_URL}?billing=portal-return`,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || "Stripe billing portal failed.",
    });
  }
});

app.listen(PORT, () => {
  console.log("AGV STRIPE BILLING SERVER RUNNING ON", PORT);
  console.log("STRIPE CONFIGURED:", Boolean(stripe));
  console.log("WEBHOOK CONFIGURED:", Boolean(STRIPE_WEBHOOK_SECRET));
  console.log("BILLING PORTAL ROUTE: ENABLED");
  console.log("APP BASE URL:", APP_BASE_URL);
  console.log("SUBSCRIPTION API:", SUBSCRIPTION_API_BASE);
  console.log("INTERNAL TEST PRICE ID:", STRIPE_INTERNAL_TEST_PRICE_ID ? "SET" : "MISSING");
  console.log("CREATOR PRICE ID:", STRIPE_CREATOR_PRICE_ID ? "SET" : "MISSING");
  console.log("MINISTRY PRICE ID:", STRIPE_MINISTRY_PRICE_ID ? "SET" : "MISSING");
  console.log("CONVENTION PRICE ID:", STRIPE_CONVENTION_PRICE_ID ? "SET" : "MISSING");
});