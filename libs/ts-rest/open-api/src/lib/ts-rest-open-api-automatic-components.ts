import * as OpenAPITools from 'openapi3-ts';

type SpecWithSchema = OpenAPITools.OpenAPIObject & {
  components: OpenAPITools.ComponentsObject;
};

type Brand<K, T> = K & { __brand: T }
type Hash = Brand<string | number, 'hash'>;

export const extractOpenApiComponents = (
  spec: OpenAPITools.OpenAPIObject,
): OpenAPITools.OpenAPIObject => {
  let components: OpenAPITools.ComponentsObject = {
    schemas: {},
  };

  const hashToSchemaMap = new Map<Hash, OpenAPITools.SchemaObject>(); // Map content hash to schema object
  const hashToNameMap = new Map<Hash, string>(); // Map schema object to schema name
  const usedNameToAllPathsMap = new Map<
    string,
    {
      paths: string[];
      operationId: string;
      isPayload: boolean;
      status: string | null;
    }[]
  >(); // Map used path to all paths

  const processSchema = (
    schema: OpenAPITools.SchemaObject,
    path: string[], // includes parent keys
    operationId: string,
    status: string | null,
    isPayload: boolean,
  ): OpenAPITools.SchemaObject => {
    // Recursively process nested schemas (only if it's an object schema)
    // Start bottoms up to ensure that all nested schemas are processed first
    if (schema.type === 'object') {
      for (const [key, subSchema] of Object.entries(schema.properties ?? {})) {
        if (typeof subSchema === 'object' && '$ref' in subSchema) {
          continue; // Skip if already a reference
        }
        schema.properties![key] = processSchema(
          subSchema as OpenAPITools.SchemaObject,
          [...path, key],
          operationId,
          status,
          isPayload,
        );
      }
    }

    // Process items in array schemas
    if (
      schema.type === 'array' &&
      schema.items &&
      typeof schema.items === 'object'
    ) {
      // we do this so simple arrays are not converted to refs
      return {
        type: 'array',
        items: processSchema(
          schema.items as OpenAPITools.SchemaObject,
          [...path, 'array-item'],
          operationId,
          status,
          isPayload,
        ),
      };
    }

    if (
      schema.type &&
      !['object', 'array'].includes(schema.type) &&
      !schema.enum
    ) {
      return schema; // Skip if not an object, array, or enum
    }

    const schemaHash = generateSchemaHash(schema);
    if (hashToSchemaMap.has(schemaHash)) {
      const existingSchemaName = hashToNameMap.get(schemaHash)!;
      // Add to all paths
      if (usedNameToAllPathsMap.has(existingSchemaName)) {
        usedNameToAllPathsMap.get(existingSchemaName)?.push({
          paths: path,
          operationId,
          isPayload,
          status,
        });
      } else {
        throw new Error('This should not happen');
      }
      return {
        $ref: `#/components/schemas/${existingSchemaName}`,
      };
    }

    const schemaName = generateSchemaName(path, operationId, isPayload, status);
    if (components.schemas![schemaName]) {
      throw new Error('Conflict in schema names,' + schemaName);
    }
    schema['$id'] = schemaName; // Assign the generated name as $id
    components.schemas![schemaName] = schema;

    // Update both maps
    hashToSchemaMap.set(schemaHash, schema);
    hashToNameMap.set(schemaHash, schemaName);
    // add to all paths
    // we know this is the first time we are seeing this object
    usedNameToAllPathsMap.set(schemaName, [
      { paths: path, operationId, isPayload, status },
    ]);
    return {
      $ref: `#/components/schemas/${schemaName}`,
    };
  };

  for (const path in spec.paths) {
    for (const method in spec.paths[path]) {
      const operation = spec.paths[path][method];
      for (const status in operation.responses) {
        const response = operation.responses[status];
        if (response.content?.['application/json']) {
          response.content['application/json']['schema'] = processSchema(
            response.content['application/json'].schema,
            [path],
            operation.operationId,
            status,
            false,
          );
        }
      }
      if (operation.requestBody?.content?.['application/json']) {
        operation.requestBody.content['application/json']['schema'] =
          processSchema(
            operation.requestBody.content['application/json'].schema,
            [path],
            operation.operationId,
            null,
            true,
          );
      }
    }
  }

  // add component to the openapi spec
  spec.components = components;
  spec = useShortestNames(usedNameToAllPathsMap, spec as SpecWithSchema);

  return spec;
};

const useShortestNames = (
  usedNameToAllPathsMap: Map<
    string,
    {
      paths: string[];
      operationId: string;
      isPayload: boolean;
      status: string | null;
    }[]
  >,
  spec: SpecWithSchema,
): SpecWithSchema => {
  // now do name cleanup
  // - iterate through allpathsmap
  // - if there are <= 1 times used, do nothing
  // - if there are >1 times used, generate a new name with the shortest path
  // - update all references to the new name, including the component name
  let components = spec.components;

  for (const [path, allPaths] of usedNameToAllPathsMap) {
    if (allPaths.length <= 1) {
      continue;
    }

    const shortestPath = allPaths.reduce((a, b) =>
      a.paths.join('.').split('.').length < b.paths.join('.').split('.').length
        ? a
        : b,
    );
    const schemaName = generateSchemaName(
      shortestPath.paths,
      shortestPath.operationId,
      shortestPath.isPayload,
      shortestPath.status,
    );
    if (schemaName === path) {
      continue;
    }

    components.schemas![schemaName] = {
      ...components.schemas![path]!,
      $id: schemaName,
    };
    delete components.schemas![path];

    // Hack, but instead of doing a deep clone, just serialize to json and back and do a string replace
    let schemaString = JSON.stringify(spec);
    const oldSchema = `"#/components/schemas/${path}"`; // include quotes to avoid partial matches
    const newSchema = `"#/components/schemas/${schemaName}"`;

    // replace all, but be mindful of regex and the special characters above
    // using a naive solution since we don't have access to replaceAll
    while (schemaString.includes(oldSchema)) {
      schemaString = schemaString.replace(oldSchema, newSchema);
    }
    spec = JSON.parse(schemaString);

    // Update components to account for string replacement
    components = spec.components!;
  }
  return spec;
};

// Generate a unique name for the schema based on its parent object keys
const generateSchemaName = (
  path: string[],
  operationId: string,
  isPayload: boolean,
  status: string | null = null,
): string => {
  // Convert path and parentKey with dashes to titlecase separated by dots, add .Payload for POST, PUT, PATCH requests
  // │ { operationId: 'createProposalDraft', path: '/v1/proposals/drafts/{id}' } => CreateProposalDraft.V1.Proposals.Drafts.Id.Count
  const nameParts = [
    operationId,
    isPayload ? 'Payload' : '',
    status && status.charAt(0) !== '2' ? status : '',
    ...path
      .join('/')
      .split('/')
      .filter(Boolean)
      .map((part) =>
        part
          .split('-')
          .map((p) => p[0]!.toUpperCase() + p.slice(1))
          .join('')
          .replace(/[^a-zA-Z0-9]/g, ''),
      ),
  ];
  const rawName = nameParts
    .filter(Boolean)
    // titlecase from camelcase
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('.')
    .replace(/[^a-zA-Z0-9.]/g, '');

  // For clarity, replace .Id with .One in the schema name
  // Ex: Customers.Id.Address => Customers.One.Address
  // Ex: Jobs.JobId => Jobs.One
  // Ex: Proposals.Id.Estimates.EstimateId => Proposals.One.Estimate.One
  const parts = rawName.split('.');
  for (let i = 1; i < parts.length; i++) {
    // Naive, but should be fine
    if (parts[i]!.slice(-2) === 'Id') {
      parts[i] = 'One';
    }
  }
  return parts.join('.');
};

// We don't care about security in this context, so we can use a simple hash function
const hashCode = (str: string) => {
   let hash = 0;
   for (let i = 0, len = str.length; i < len; i++) {
       let chr = str.charCodeAt(i);
       hash = (hash << 5) - hash + chr;
       hash |= 0; // Convert to 32bit integer
   }
   return hash;
}



// Generate a hash of the schema content for comparison
const generateSchemaHash = (schema: OpenAPITools.SchemaObject): Hash => {
  return hashCode(JSON.stringify(schema)) as Hash;
  // return crypto
  //   .createHash('sha256')
  //   .update(JSON.stringify(schema))
  //   .digest('hex');
};
