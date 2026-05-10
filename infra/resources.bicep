param location string
param resourceToken string
param tags object

@secure()
param githubToken string
param copilotModel string

var abbrs = loadJsonContent('./abbreviations.json')

// ─── Log Analytics + App Insights ────────────────────────────────────────
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${abbrs.operationalInsightsWorkspaces}${resourceToken}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource appi 'Microsoft.Insights/components@2020-02-02' = {
  name: '${abbrs.insightsComponents}${resourceToken}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}

// ─── Container Registry ──────────────────────────────────────────────────
resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: '${abbrs.containerRegistryRegistries}${resourceToken}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

// ─── App Service Plan (Linux) ────────────────────────────────────────────
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${abbrs.webServerFarms}${resourceToken}'
  location: location
  tags: tags
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

// ─── User-assigned managed identity (for ACR pull + Azure access) ────────
resource uami 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${abbrs.managedIdentityUserAssignedIdentities}${resourceToken}'
  location: location
  tags: tags
}

// AcrPull role assignment for the app's managed identity
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
resource acrPullAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, uami.id, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: uami.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ─── Web App for Containers ──────────────────────────────────────────────
resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: '${abbrs.webSitesAppService}${resourceToken}'
  location: location
  tags: union(tags, { 'azd-service-name': 'app' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${uami.id}': {}
    }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    keyVaultReferenceIdentity: uami.id
    siteConfig: {
      linuxFxVersion: 'DOCKER|${acr.properties.loginServer}/ledgerlens:latest'
      acrUseManagedIdentityCreds: true
      acrUserManagedIdentityID: uami.properties.clientId
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      healthCheckPath: '/health'
      appSettings: [
        { name: 'WEBSITES_PORT',                                value: '3002' }
        { name: 'PORT',                                         value: '3002' }
        { name: 'NODE_ENV',                                     value: 'production' }
        { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE',          value: 'false' }
        { name: 'DOCKER_REGISTRY_SERVER_URL',                   value: 'https://${acr.properties.loginServer}' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING',        value: appi.properties.ConnectionString }
        { name: 'GITHUB_TOKEN',                                 value: githubToken }
        { name: 'LEDGERLENS_COPILOT_MODEL',                     value: copilotModel }
      ]
    }
  }
  dependsOn: [
    acrPullAssignment
  ]
}

output appServiceName string = app.name
output appServiceUri string = 'https://${app.properties.defaultHostName}'
output containerRegistryName string = acr.name
output containerRegistryLoginServer string = acr.properties.loginServer
