// Backend API client - connects to secure backend server

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';

let token = localStorage.getItem("agrihub_token");

export function setToken(t) {
  token = t;
  if (t) localStorage.setItem("agrihub_token", t);
  else localStorage.removeItem("agrihub_token");
}

export function getToken() { return token; }

// Helper function for API calls
async function apiCall(endpoint, options = {}) {
  const url = `${API_BASE_URL}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || error.message || 'Request failed');
  }

  return response.json();
}

export const api = {
  // Auth
  login: async (username, password) => {
    const data = await apiCall('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setToken(data.token);
    return data;
  },

  // Fields
  getFields: async () => {
    return apiCall('/fields');
  },
  getField: async (id) => {
    return apiCall(`/fields/${id}`);
  },
  createField: async (data) => {
    return apiCall('/fields', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  updateField: async (id, data) => {
    return apiCall(`/fields/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  deleteField: async (id) => {
    return apiCall(`/fields/${id}`, {
      method: 'DELETE',
    });
  },

  // Transactions
  getTransactions: async () => {
    return apiCall('/transactions');
  },
  createTransaction: async (data) => {
    return apiCall('/transactions', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  updateTransaction: async (id, data) => {
    return apiCall(`/transactions/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  deleteTransaction: async (id) => {
    return apiCall(`/transactions/${id}`, {
      method: 'DELETE',
    });
  },

  // M-Pesa
  initiatePayment: async (transaction_id, phone, amount) => {
    return apiCall(`/transactions/${transaction_id}/initiate-payment`, {
      method: 'POST',
      body: JSON.stringify({ phone, amount }),
    });
  },
  stkPush: async (transaction_id, phone, amount) => {
    return apiCall('/mpesa/stkpush', {
      method: 'POST',
      body: JSON.stringify({ transaction_id, phone, amount }),
    });
  },
  mpesaStatus: async (transaction_id) => {
    return apiCall(`/mpesa/status/${transaction_id}`);
  },
  mpesaConfirm: async (transaction_id, ok) => {
    return apiCall('/mpesa/confirm', {
      method: 'POST',
      body: JSON.stringify({ transaction_id, ok }),
    });
  },

  // Reports
  dashboard: async () => {
    return apiCall('/reports/dashboard');
  },
  report: async (start, end) => {
    return apiCall('/reports/report', {
      method: 'POST',
      body: JSON.stringify({ start, end }),
    });
  },

  // Analysis Unlocks
  analysis: {
    getUnlockPrice: async (fieldId) => {
      return apiCall(`/analysis-unlocks/price/${fieldId}`);
    },
    requestUnlock: async (fieldId, phoneNumber) => {
      return apiCall('/analysis-unlocks/request', {
        method: 'POST',
        body: JSON.stringify({ fieldId, phoneNumber }),
      });
    },
    checkUnlockStatus: async (unlockId) => {
      return apiCall(`/analysis-unlocks/status/${unlockId}`);
    },
    checkFieldUnlocked: async (fieldId) => {
      return apiCall(`/analysis-unlocks/field/${fieldId}`);
    },
    getHistory: async () => {
      return apiCall('/analysis-unlocks/history');
    }
  }
};
