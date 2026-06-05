@description('Name of the Azure Static Web App resource')
param staticWebAppName string

@description('Azure location for the Static Web App')
param location string = resourceGroup().location

@description('SKU for the Static Web App')
@allowed([
  'Free'
  'Standard'
])
param sku string = 'Free'

resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: staticWebAppName
  location: location
  sku: {
    name: sku
    tier: sku
  }
  properties: {}
}

output staticWebAppId string = staticWebApp.id
output staticWebAppName string = staticWebApp.name
