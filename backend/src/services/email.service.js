const nodemailer = require('nodemailer');

/**
 * Email is optional in development. If any of the OAuth env vars are missing,
 * we return a no-op sender so the app boots and works end-to-end without a
 * mail account configured. Set them in .env to enable real sends.
 */
const requiredEnv = ["EMAIL_USER", "CLIENT_ID", "CLIENT_SECRET", "REFRESH_TOKEN"];
const missing = requiredEnv.filter((k) => !process.env[k]);
const emailEnabled = missing.length === 0;

let transporter = null;

if (emailEnabled) {
    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            type: 'OAuth2',
            user: process.env.EMAIL_USER,
            clientId: process.env.CLIENT_ID,
            clientSecret: process.env.CLIENT_SECRET,
            refreshToken: process.env.REFRESH_TOKEN,
        },
    });

    transporter.verify((error) => {
        if (error) {
            console.error('Email server not ready:', error.message);
        } else {
            console.log('Email server is ready to send messages');
        }
    });
} else {
    console.log(
        `[email] disabled (missing env: ${missing.join(", ")}). Emails will be skipped.`
    );
}


const sendEmail = async (to, subject, text, html) => {
    if (!emailEnabled) return;
    try {
        const info = await transporter.sendMail({
            from: `"Tensai SecBank" <${process.env.EMAIL_USER}>`,
            to,
            subject,
            text,
            html,
        });
        console.log('Message sent: %s', info.messageId);
    } catch (error) {
        console.error('Error sending email:', error.message);
    }
};


async function sendRegistrationEmail(userEmail, name) {
    const subject = 'Welcome to Tensai SecBank!';
    const text = `Hello ${name},\n\nThank you for registering at Tensai SecBank. We're excited to have you on board!\n\nBest regards,\nThe Tensai SecBank Team`;
    const html = `<p>Hello ${name},</p><p>Thank you for registering at Tensai SecBank. We're excited to have you on board!</p><p>Best regards,<br>The Tensai SecBank Team</p>`;

    await sendEmail(userEmail, subject, text, html);
}

async function sendTransactionEmail(userEmail, name, amount, toAccount) {
    const subject = 'Transaction Successful!';
    const text = `Hello ${name},\n\nYour transaction of $${amount} to account ${toAccount} was successful.\n\nBest regards,\nThe Tensai SecBank Team`;
    const html = `<p>Hello ${name},</p><p>Your transaction of $${amount} to account ${toAccount} was successful.</p><p>Best regards,<br>The Tensai SecBank Team</p>`;

    await sendEmail(userEmail, subject, text, html);
}

async function sendTransactionFailureEmail(userEmail, name, amount, toAccount) {
    const subject = 'Transaction Failed';
    const text = `Hello ${name},\n\nWe regret to inform you that your transaction of $${amount} to account ${toAccount} has failed. Please try again later.\n\nBest regards,\nThe Tensai SecBank Team`;
    const html = `<p>Hello ${name},</p><p>We regret to inform you that your transaction of $${amount} to account ${toAccount} has failed. Please try again later.</p><p>Best regards,<br>The Tensai SecBank Team</p>`;

    await sendEmail(userEmail, subject, text, html);
}

module.exports = {
    sendRegistrationEmail,
    sendTransactionEmail,
    sendTransactionFailureEmail
};
