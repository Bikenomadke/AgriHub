# AgriHub Field Command

A premium, highly interactive agricultural yield management, boundary mapping, and weighbridge trading React application built with **Vite** and styled with modern dark-gold glassmorphism.

---

## 🚀 How to Run the App Locally

Since terminal execution requires local system permission, you can spin up this application on your machine in just **two simple steps**:

1. **Install Dependencies**
   Open your terminal (PowerShell, CMD, or Git Bash) in this project directory (`c:\Users\USER\OneDrive\Desktop\AgriHub`) and run:
   ```bash
   npm install
   ```

2. **Start the Development Server**
   Launch the high-performance Vite local server by running:
   ```bash
   npm run dev
   ```
   *Vite will automatically open the application in your default browser at **http://localhost:3000**.*

---

## 🛠️ Project Structure

The project has been successfully set up with a clean React + Vite architecture:

```
AgriHub/
├── index.html          # HTML entry point (SEO optimized, fonts preloaded)
├── package.json        # Project manifest, React & Recharts dependencies
├── vite.config.js      # Vite build & live-reload server configuration
├── README.md           # This documentation guide
└── src/
    ├── main.jsx        # React DOM bootstrap entrypoint
    └── App.jsx         # Core application containing screens, Leaflet mapper & states
```

---

## ⚡ Technical Highlights

* **GPS Boundary Mapper**: A high-precision interactive boundary builder utilizing Leaflet JS satellite overlays, shoelace polygon integration, and manual haversine calculations.
* **Live Financial Arbitrage**: Real-time weighbridge margin tracking with dynamic payout estimations in Kenyan Shillings (KES).
* **Automated Yield Forecasting**: Custom state multipliers that calculate predicted sugarcane yield based on node and stalk counts.
* **Analytical Visualizations**: Beautiful, responsive progress donuts, time-series area charts, and comparative histograms powered by `recharts`.

---

## 🔑 Preset Credentials

The login screen features role-based access. Since the demo buttons have been removed from the UI for production layout, use the following preset credentials to log in:

| Role | Username | Password | Access Privileges |
|---|---|---|---|
| 🟡 **System Admin** | `admin` | `agrihub2026` | Full Access, Reports, Dashboard, Multi-source Import |
| 🟢 **Field Data Officer** | `officer` | `field123` | Fields only, Interactive Professional Survey, GIS export (GeoJSON/KML/JSON) |
| 🔵 **Weighbridge Trader** | `trader` | `trade123` | Trade only, Weighbridge entry logging, Trade data export (CSV/JSON) |

