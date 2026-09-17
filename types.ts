export type Risk = "高風險" | "中風險" | "低風險" | "無";
export type IssueStatus = "已上報" | "已派發" | "整改中" | "待驗證" | "已銷項";

export type Issue = {
  id: string;
  photoIndex: number;
  category: "6S" | "TPM" | "職業安全" | "消防";
  riskLevel: Risk;
  description: string;
  standardReference: string;
  recommendation: string;
  assignee: string;
  dueDate: string;
  status: IssueStatus;
};

export type Report = { photoIndex: number; assessment: string; issues: Issue[] };

export type Audit = {
  id: string;
  createdAt: string;
  auditorName: string;
  employeeId: string;
  workflowType: string;
  locations: string[];
  responsiblePerson: string;
  auditFocus: string;
  notes: string;
  summary: string;
  images: string[];
  reports: Report[];
  model: string;
};
