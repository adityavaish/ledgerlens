targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the environment that can be used as part of naming resource convention')
param environmentName string

@minLength(1)
@description('Primary location for all resources')
param location string

@description('Optional override for the resource group name')
param resourceGroupName string = ''

@description('GitHub Copilot SDK token (set via `azd env set GITHUB_TOKEN ...`).')
@secure()
param githubToken string = ''

@description('Default Copilot model name')
param copilotModel string = 'claude-opus-4.6'

var abbrs = loadJsonContent('./abbreviations.json')
var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))
var tags = { 'azd-env-name': environmentName }

resource rg 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: !empty(resourceGroupName) ? resourceGroupName : '${abbrs.resourcesResourceGroups}${environmentName}'
  location: location
  tags: tags
}

module resources 'resources.bicep' = {
  scope: rg
  name: 'resources'
  params: {
    location: location
    resourceToken: resourceToken
    tags: tags
    githubToken: githubToken
    copilotModel: copilotModel
  }
}

output AZURE_LOCATION string = location
output AZURE_RESOURCE_GROUP string = rg.name
output SERVICE_APP_NAME string = resources.outputs.appServiceName
output SERVICE_APP_URI string = resources.outputs.appServiceUri
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.containerRegistryLoginServer
output AZURE_CONTAINER_REGISTRY_NAME string = resources.outputs.containerRegistryName
