import { IsString, IsNotEmpty, IsArray, IsOptional } from 'class-validator';

/** POST /api/codebase/index — 首次全量索引 */
export class IndexDto {
  @IsString()
  @IsNotEmpty()
  source!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;
}

/** POST /api/codebase/update — 增量更新(webhook) */
export class UpdateDto {
  @IsString()
  @IsNotEmpty()
  source!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  changed_files?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  deleted_files?: string[];
}
