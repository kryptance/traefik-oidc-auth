const { execSync } = require('child_process');

async function setupKeycloak(keycloakPort) {
  console.log('Setting up Keycloak client for tests...');

  const ADMIN_CLI_ID = 'admin-cli';
  const CLIENT_ID = 'traefik';
  const CLIENT_SECRET = 'LQslcjK8ZeRrrhW7jKaFUUous9W5QvCr';
  const KEYCLOAK_URL = `http://localhost:${keycloakPort}`;

  try {
    // Get admin token
    console.log('Getting admin token...');
    const tokenResponse = await fetch(`${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: ADMIN_CLI_ID,
        username: 'admin',
        password: 'admin'
      }),
    });

    if (!tokenResponse.ok) {
      throw new Error(`Failed to get admin token: ${tokenResponse.status} ${tokenResponse.statusText}`);
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    // Check if traefik client already exists
    console.log('Checking if traefik client exists...');
    const clientsResponse = await fetch(`${KEYCLOAK_URL}/admin/realms/master/clients`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!clientsResponse.ok) {
      throw new Error(`Failed to get clients: ${clientsResponse.status} ${clientsResponse.statusText}`);
    }

    const clients = await clientsResponse.json();
    const existingClient = clients.find(client => client.clientId === CLIENT_ID);

    if (existingClient) {
      console.log('✅ Traefik client already exists');
      return;
    }

    // Create traefik client
    console.log('Creating traefik client...');
    const createClientResponse = await fetch(`${KEYCLOAK_URL}/admin/realms/master/clients`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientId: CLIENT_ID,
        enabled: true,
        clientAuthenticatorType: 'client-secret',
        secret: CLIENT_SECRET,
        redirectUris: ['*'],
        webOrigins: ['*'],
        protocol: 'openid-connect',
        publicClient: false,
        serviceAccountsEnabled: true,
        directAccessGrantsEnabled: true,
        implicitFlowEnabled: false,
        standardFlowEnabled: true
      }),
    });

    if (!createClientResponse.ok) {
      const errorText = await createClientResponse.text();
      throw new Error(`Failed to create client: ${createClientResponse.status} ${createClientResponse.statusText} - ${errorText}`);
    }

    console.log('✅ Traefik client created successfully');

  } catch (error) {
    console.error('Failed to setup Keycloak:', error.message);
    throw error;
  }
}

module.exports = { setupKeycloak };