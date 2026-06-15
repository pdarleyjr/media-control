# MBFD Live USB Import Design

## Goal

Future MBFD Live USB Import lets an instructor insert a USB drive, choose supported files on the touchscreen, and import them into Live Session Content without ever executing or displaying files directly from the USB device.

## Secure Flow

1. USB inserted.
2. Podium agent detects removable media.
3. Agent reports `USB detected` to the console.
4. USB is mounted read-only with `noexec,nodev,nosuid` by a controlled service, not desktop automount.
5. Instructor selects supported files.
6. Files are copied into a local quarantine/staging directory.
7. File extensions, MIME types, magic bytes, size, path traversal, symlinks, duplicates, and archive depth are validated.
8. Files are scanned.
9. Clean files are uploaded to MBFD Hub/Media Control.
10. GMKtec conversion workers generate thumbnails, PDFs/images/video derivatives, and presentation previews.
11. Imported files appear in Live Session Content.
12. Instructor sends content to Video Wall 1, Video Wall 2, Smartboard, or Broadcast.
13. USB is unmounted/ejected.

## Allowed Future File Types

- `.pdf`
- `.ppt`
- `.pptx`
- `.doc`
- `.docx`
- `.jpg`
- `.jpeg`
- `.png`
- `.webp`
- `.mp4`
- `.mov`
- `.mkv`

## Blocked File Types

- `.exe`
- `.msi`
- `.bat`
- `.cmd`
- `.ps1`
- `.sh`
- `.scr`
- `.vbs`
- `.js`
- `.jar`
- `.iso`

## Recommended Tools

- USBGuard for device policy.
- udev only for detection/tagging, not long-running import work.
- systemd service triggered by udev for controlled mount/copy/scan.
- ClamAV for malware scanning.
- LibreOffice headless for Office document conversion.
- FFmpeg/ffprobe for media inspection and transcodes.
- PDF thumbnail generation through Poppler or similar tooling.

## V1 Scaffold Present Now

- `mbfd-podium-agent` exposes `GET /usb/status`.
- It reports removable block-device data from `lsblk`.
- It does not mount USB devices.
- It does not open USB content.
- It does not execute anything from USB.

## Future Agent Endpoints

- `GET /usb/status`
- `POST /usb/scan`
- `POST /usb/stage`
- `POST /usb/eject`
- `GET /usb/imports/:id`

## Future Staging Directories

- `/var/lib/mbfd/usb-import/quarantine`
- `/var/lib/mbfd/usb-import/clean`
- `/var/lib/mbfd/usb-import/rejected`

## Non-Negotiable Rule

Never display directly from USB. Always copy, validate, scan, upload, and convert before content appears in the classroom control UI.
