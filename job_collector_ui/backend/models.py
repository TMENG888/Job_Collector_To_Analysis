from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, field_validator


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    @field_validator("confirmed", "shareConfirmed", check_fields=False, mode="before")
    @classmethod
    def explicit_confirmation(cls, value):
        if value is not True:
            raise ValueError("需要明确确认本次操作")
        return value


class TrainingCreate(Contract):
    taskId: str = Field(min_length=1, max_length=240)
    keywords: str = Field(default="", max_length=240)


class CollectionKeywords(Contract):
    role: str = Field(min_length=2, max_length=120)


class TrainingStart(Contract):
    id: str = Field(min_length=1, max_length=80)
    confirmed: Literal[True]
    sampleCount: StrictInt = Field(default=500, ge=500, le=500)
    schemaBudget: float = Field(default=.1, ge=.05, le=.5)
    labelBudget: float = Field(default=1.9, gt=0, le=20)


class RunIdentity(Contract):
    id: str = Field(min_length=1, max_length=80)


class ResumeRun(RunIdentity):
    confirmed: Literal[True]


class ClassifierStart(Contract):
    inputFile: str = Field(min_length=1, max_length=2000)
    role: str = Field(min_length=1, max_length=240)
    sampleCount: StrictInt = Field(default=500, ge=500, le=500)
    budget: float = Field(default=2, gt=0, le=20)
    inputPrice: float | None = Field(default=None, gt=0, le=100)
    outputPrice: float | None = Field(default=None, gt=0, le=100)
    jointAnnotations: StrictBool = False


class InsightRun(Contract):
    forceRefresh: StrictBool = False
    inputFile: str = Field(min_length=1, max_length=2000)
    role: str = Field(default="", max_length=240)
    analysisMode: Literal["full", "preview"] = "full"
    sampleSize: StrictInt = Field(default=300, ge=50, le=2000)
    sheetName: str = Field(default="岗位数据", max_length=160)
    sourceTaskId: str | None = None
    classifierMode: Literal["qualified", "candidate-trial"] = "qualified"
    classifierRunId: str | None = None


class ComputeRequest(Contract):
    kind: Literal["classifier", "interview_prepare", "interview_train", "cluster", "analysis", "resume_matching"]
    folder: str | None = None
    inputFile: str | None = None
    outputFile: str | None = None
    requestId: str = Field(min_length=1, max_length=80)


class SemanticStart(Contract):
    inputFile: str = Field(min_length=1, max_length=2000)
    role: str = Field(default="", max_length=240)
    sampleCount: StrictInt = Field(default=200, ge=1, le=1000)
    budget: float = Field(default=.5, gt=0, le=20)
    shareConfirmed: Literal[True]


class SchemaDraft(Contract):
    inputFile: str = Field(min_length=1, max_length=2000)
    role: str = Field(min_length=1, max_length=240)
    budget: float = Field(default=.1, gt=0, le=.5)
    shareConfirmed: Literal[True]
    notes: str = Field(default="", max_length=3000)


class ClassifierDelete(Contract):
    role: str = Field(min_length=1, max_length=240)
    confirmed: Literal[True]


class DiscoveryName(Contract):
    confirmed: Literal[True]
    budget: float = Field(default=.5, ge=.05, le=.5)


class MatchingStart(Contract):
    role: str = Field(min_length=1, max_length=240)
    resume: str = Field(min_length=40, max_length=40000)
    filename: str = Field(default="", max_length=240)
    budget: float = Field(default=.5, ge=.05, le=.5)
    shareConfirmed: Literal[True]
    requestId: str = Field(min_length=36, max_length=36)


class MatchingResume(RunIdentity):
    shareConfirmed: Literal[True]


class MatchingAssess(MatchingResume):
    keys: list[str] = Field(min_length=1, max_length=10)
    requestId: str = Field(min_length=36, max_length=36)
