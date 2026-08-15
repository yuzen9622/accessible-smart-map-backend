import mongoose from "mongoose";
import SosSession from "../model/sos-session.model";
import EmergencyContact from "../model/emergency-contact.model";
import User from "../model/user.model";

const uri = process.env.DATABASE_URL || "";

async function main() {
  if (!uri) {
    console.error("No DATABASE_URL found");
    return;
  }
  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const sessionId = "6a4f4dfab1929adea6183cbb";
  console.log(`Querying SosSession for ID: ${sessionId}`);

  const session = await SosSession.findById(sessionId).lean();
  console.log("SosSession:", JSON.stringify(session, null, 2));

  if (session) {
    console.log(`Querying EmergencyContact for userId: ${session.userId}`);
    const contacts = await EmergencyContact.find({
      userId: String(session.userId),
    }).lean();
    console.log("EmergencyContacts:", JSON.stringify(contacts, null, 2));

    const user = await User.findById(session.userId).lean();
    console.log("User:", JSON.stringify(user, null, 2));
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  mongoose.disconnect();
});
