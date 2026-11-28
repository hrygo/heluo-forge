/**
 * 需求域同源 HTTP 路由表：`/requirements`、`/rmp/docs`、`/rmp/outline`。
 */

/**
 * 声明需求域路由。
 *
 * @param {{ getRequirements: Function, searchRmpDocs: Function, getRmpOutline: Function }} service
 * @param {{ toIntOrDefault: Function }} helpers
 */
export function createRequirementRoutes(service, helpers) {
  const { toIntOrDefault } = helpers;

  return [
    {
      path: '/requirements',
      methods: ['GET', 'HEAD'],
      allow: 'GET',
      async handler({ params }) {
        return service.getRequirements({
          view: params?.get('view') || 'managedByMe',
          search: params?.get('search') || '',
          pageNum: toIntOrDefault(params?.get('pageNum'), 1, 1, 200),
          pageSize: toIntOrDefault(params?.get('pageSize'), 20, 1, 100),
        });
      },
    },
    {
      path: '/rmp/docs',
      methods: ['GET', 'HEAD'],
      allow: 'GET',
      async handler({ params }) {
        return service.searchRmpDocs({
          quickSearch: params?.get('quickSearch') || '',
          latestOnly: params?.get('latestOnly') === 'true' || params?.get('latestOnly') === '1',
          reqCode: params?.get('reqCode') || '',
          currentPage: toIntOrDefault(params?.get('currentPage'), 1, 1, 200),
          numPerPage: toIntOrDefault(params?.get('numPerPage'), 10, 1, 50),
        });
      },
    },
    {
      path: '/rmp/outline',
      methods: ['GET', 'HEAD'],
      allow: 'GET',
      async handler({ params }) {
        return service.getRmpOutline({
          docId: params?.get('docId') || '',
          associatedSystem: params?.get('associatedSystem') || '',
          currentPage: toIntOrDefault(params?.get('currentPage'), 1, 1, 200),
          numPerPage: toIntOrDefault(params?.get('numPerPage'), 100, 1, 500),
        });
      },
    },
  ];
}
