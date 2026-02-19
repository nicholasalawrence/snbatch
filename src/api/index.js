/**
 * Axios client factory.
 * Returns a pre-configured instance — not a singleton, so reconcile can hold two clients.
 */
import axios from 'axios';

/**
 * @param {{ baseUrl: string, username: string, password: string }} credentials
 * @returns {import('axios').AxiosInstance}
 */
export function createClient({ baseUrl, username, password }) {
  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  return axios.create({
    baseURL: baseUrl,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 60_000,
  });
}
