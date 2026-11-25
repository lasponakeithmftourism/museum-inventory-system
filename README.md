# Museum Inventory System

A Windows desktop register for museum artifacts, artworks, books, costumes, buildings, heritage sites, old photos, and old documents. The app is built with Electron, React, and Firebase Firestore. It provides authenticated access, record management, search/filtering, live cloud updates, detail views, CSV export, and customizable print layouts with signatory blocks.

## Firebase setup

1. In the Firebase Console, create or select a Firebase project and add a **Web app**.
2. Enable **Authentication → Sign-in method → Email/Password**. Create the user account(s) who should access the collection register.
3. Create a **Cloud Firestore** database.
4. From the project folder, copy `.env.example` to `.env.local` and fill in the Firebase web app config values. The app requires the API key, project ID, and app ID.
5. In Firestore **Rules**, publish the contents of `firestore.rules`.
6. Install Node.js LTS, open a terminal in this folder, then run:

   ```powershell
   npm.cmd install
   npm.cmd run dev
   ```

The app shows a setup screen when required Firebase settings are missing. Restart the development app after changing `.env.local`. Once configured, sign in with your Firebase account each time you open or reload the app.

Run `npm.cmd run typecheck` to check the TypeScript code or `npm.cmd run build` to check and build the renderer.

## Build a Windows installer

After Firebase configuration, run:

```powershell
npm.cmd run dist:win
```

The Windows installer is generated in `release/`. The renderer bundle includes your Firebase web app settings at build time. Rebuild and reinstall the application after changing those settings.

## Record data

The app assigns Inventory IDs when new records are saved, using the format `YYYY-NNN` (for example, `2026-001`). Each year has its own sequence from `001` to `999` based on the calendar in Manolo Fortich. The next ID follows the highest ID still in the register. If `2026-001` and `2026-002` are the only records and you delete `2026-002`, the next record gets `2026-002` again. Deleting a record below the highest ID leaves a gap.

Records include Inventory ID, Item Title, Description, Item Type, Creator/Artist/Maker, Date Created/Estimated, Date Received/Assigned, Acquisition Method, Donor/Seller/Source, Provenance/Known History, Ownership/Loan Status, Condition, Current Location, Supporting Record Reference, Follow-up/Remarks, and Last Updated. CSV export includes all fields for the currently filtered records.

## Google Drive attachments

1. Enable the [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) in your Google Cloud project.
2. Configure OAuth consent for your Google account and create a [Desktop app OAuth client](https://developers.google.com/workspace/guides/create-credentials#desktop-app). If your project uses an external testing audience, add your Google account as a test user.
3. Download the client JSON. Sign in to the collection register, open **Add collection record**, and select **Connect Google Drive** in **Photos & attachments**. Select the JSON and approve access in your browser.
4. Choose **Add files** to select photos or documents, then save the record.

The app creates a folder such as `My Drive / Museum Inventory System / 2026 / 2026-001` based on the inventory ID. Legacy records without a known year use `Undated`. Open the record to see its files and the folder link. Edit the record to add more files. If an upload fails, keep the editor open and choose **Retry uploads** to continue with the saved inventory ID.

Google credentials are encrypted on your device. Firestore stores the folder reference. Drive sharing permissions control who can open the files.

When you delete a linked record, the app moves its folder and contents to Google Drive Trash before removing the record from the register. The highest ID becomes available for reuse after deletion finishes. A new record with a reused ID gets its own Drive folder when you add attachments. Connect a Google account with permission to trash the original folder. If a deletion is interrupted, reopen the record and choose **Finish deletion** to retry.

## Printing

In **Print setup**, choose typed text or a PNG, JPEG, or WebP image for each custom header and footer. The app prepares larger images for printing and saves the header, footer, and signatories in the shared `museumSettings/print` document.

Select **Print register** to preview the records that match your search and ownership filters. Choose **All years** or a specific inventory year, and select one or more collection types or **All types**. The year comes from the Inventory ID, with Date Received / Assigned used when the ID has no year.

Choose a summary register or full record details, then adjust the paper size, orientation, and four margins in millimetres. The preview updates as you make changes. Select **Print** when ready to choose a printer.
