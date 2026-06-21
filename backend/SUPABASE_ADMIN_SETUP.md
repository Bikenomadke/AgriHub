# Supabase Admin Account Setup Instructions

## Overview
The AgriHub backend now uses Supabase for admin authentication. This provides better security, centralized user management, and consistency across all user types.

## Setup Steps

### 1. Access Supabase Dashboard
- Go to https://supabase.com/dashboard
- Sign in with your Supabase account
- Select your project (AgriHub)

### 2. Create Admin User
- Navigate to **Authentication** → **Users**
- Click **Add User** → **Create New User**
- Enter the following details:
  - **Email**: `Jumawycliffe81@gmail.com`
  - **Password**: `Juma@dramontray12` (or your preferred secure password)
  - **Auto Confirm User**: ✅ (enabled)
- Click **Create User**

### 3. Set User Metadata
- After creating the user, click on the user in the list
- Scroll to **User Metadata** section
- Add the following metadata:
  ```json
  {
    "role": "Admin",
    "name": "System Administrator"
  }
  ```
- Click **Save**

### 4. Verify Configuration
- Ensure your `.env` file has the following Supabase configuration:
  ```
  SUPABASE_URL=https://lykcuuxsplszplkoqlao.supabase.co
  SUPABASE_ANON_KEY=sb_publishable_sWFd-3SM9f-aBvtGCKzYZg_x45ooUCU
  SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
  ```

### 5. Test Admin Login
- Start the backend server: `npm run dev`
- Use the following login credentials:
  - **Email**: `Jumawycliffe81@gmail.com`
  - **Password**: `Juma@dramontray12`
- Send POST request to `/api/auth/login` with:
  ```json
  {
    "email": "Jumawycliffe81@gmail.com",
    "password": "Juma@dramontray12"
  }
  ```

## How It Works

### Authentication Flow
1. **Admin Login**: Uses Supabase authentication
2. **Field Officer/Trader Login**: Uses Supabase authentication (created by admin)
3. **Local Database**: Stores user metadata and application data
4. **Session Management**: JWT tokens issued by backend after Supabase auth

### User Creation by Admin
- Admin can create field officer and trader accounts via `/api/user-management/field-officers` and `/api/user-management/traders`
- These accounts are created in both Supabase (for auth) and local database (for app data)
- Users can login using their Supabase credentials

### Security Benefits
- **No Hardcoded Credentials**: Admin credentials stored securely in Supabase
- **Centralized Management**: All users managed in one place
- **Built-in MFA**: Supabase provides multi-factor authentication
- **Session Management**: Supabase handles session security
- **Audit Trail**: Supabase provides authentication logging

## Troubleshooting

### Login Fails
- Verify Supabase credentials are correct
- Check that user is confirmed in Supabase
- Ensure backend has correct Supabase configuration
- Check backend logs for authentication errors

### User Not Found in Local Database
- The system automatically creates local database records for Supabase users on first login
- Check that the user's email matches exactly (case-sensitive)
- Verify the user has the correct role in Supabase metadata

### Supabase Connection Issues
- Verify SUPABASE_URL and SUPABASE_ANON_KEY are correct
- Check that Supabase project is active
- Ensure network connectivity to Supabase

## Migration Notes

If you have existing admin users in the local database:
1. Create corresponding users in Supabase
2. Update their `supabase_id` in the local database
3. Users will automatically migrate to Supabase auth on next login
4. Old password-based auth remains as fallback for backward compatibility
